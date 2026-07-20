import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createProject,
  createRun,
  createWorkflow,
  getAgentWorkspace,
  updateAgent,
  updateJob,
  updateProject,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

// ---------------------------------------------------------------------------
// Workspace slugs — projects and agents get a slug at creation time, immutable
// on rename, unique per scope (project: instance-wide, agent: per-project).
// The run payload carries both slugs so runners nest workspace dirs as
// workspaces/<project>/<agent> instead of a flat display-name-derived folder
// two same-named agents in different projects would silently share.
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  const db = freshDb();
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
});

describe("slug assignment at creation", () => {
  it("sets the slug on projects and agents from the name", () => {
    const project = createProject("  Dev_Project!! ")!;
    expect(project.slug).toBe("dev-project");

    const agent = createAgent(project.id, "Dev Agent");
    expect(agent.slug).toBe("dev-agent");
  });

  it("rejects names with no letters or numbers at both scopes", () => {
    expect(() => createProject("日本語")).toThrow(InvalidNameError);

    const project = createProject("Website")!;
    expect(() => createAgent(project.id, "🚀🚀")).toThrow(InvalidNameError);
  });
});

describe("slug uniqueness scopes", () => {
  it("project slugs are unique instance-wide, lookalikes included", () => {
    createProject("Website");
    expect(() => createProject("website")).toThrow(NameCollisionError);
    expect(() => createProject("  WEBSITE!! ")).toThrow(NameCollisionError);
  });

  it("agent slugs are unique per project; the same name works in a sibling project", () => {
    const p1 = createProject("Website")!;
    const p2 = createProject("Mobile")!;
    createAgent(p1.id, "Dev Agent");
    // The lookalike that motivated the feature: different display name, same slug.
    expect(() => createAgent(p1.id, "Dev_Agent")).toThrow(NameCollisionError);
    expect(createAgent(p2.id, "Dev Agent").slug).toBe("dev-agent");
  });

  it("collision errors name the existing entity for the dialog", () => {
    createProject("Website");
    expect(() => createProject("WEBSITE!")).toThrow(/A project named "Website" already exists/);

    const project = createProject("Mobile")!;
    createAgent(project.id, "Dev Agent");
    expect(() => createAgent(project.id, "Dev_Agent")).toThrow(
      /An agent named "Dev Agent" already exists in this project/,
    );
  });
});

describe("slugs are immutable on rename", () => {
  it("updateProject/updateAgent change the name but keep the slug", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev Agent");

    const renamedProject = updateProject(project.id, { name: "Website v2" });
    expect(renamedProject.name).toBe("Website v2");
    expect(renamedProject.slug).toBe("website");

    const renamedAgent = updateAgent(agent.id, { name: "Dev Agent Prime" });
    expect(renamedAgent.name).toBe("Dev Agent Prime");
    expect(renamedAgent.slug).toBe("dev-agent");
  });
});

describe("run payload workspace block", () => {
  function agentRunPayload() {
    const project = createProject("Dev_Project")!;
    const agent = createAgent(project.id, "Dev Agent");
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;
    return { project, agent, job, run };
  }

  it("carries the project/agent slugs for an agent run", () => {
    const { run } = agentRunPayload();
    const payload = buildRunPayload(run.id)!;
    expect(payload.workspace).toEqual({
      project: "dev-project",
      agent: "dev-agent",
    });
  });

  it("keeps the original slugs after renames — workspace paths stay stable", () => {
    const { project, agent, run } = agentRunPayload();
    updateProject(project.id, { name: "Renamed Project" });
    updateAgent(agent.id, { name: "Renamed Agent" });

    const payload = buildRunPayload(run.id)!;
    expect(payload.workspace).toEqual({
      project: "dev-project",
      agent: "dev-agent",
    });
  });

  it("omits the workspace key for a workflow run (no agent, no CLI, no workspace)", () => {
    const project = createProject("Ops")!;
    const workflow = createWorkflow(project.id, {
      name: "Health Check",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const run = createRun(workflow.id, null)!;
    const payload = buildRunPayload(run.id)!;
    expect("workspace" in payload).toBe(false);
  });

  it("getAgentWorkspace returns null for an unknown agent", () => {
    expect(getAgentWorkspace("nope")).toBeNull();
  });
});

describe("run payload scripts_dir", () => {
  it("nests an agent job's scripts under <project>/<agent>/<job-leaf>", () => {
    const project = createProject("Dev_Project")!;
    const agent = createAgent(project.id, "Dev Agent");
    const job = createJob(project.id, agent.id, { name: "Build Site", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.job.scripts_dir).toBe(`dev-project/dev-agent/build-site-${job.id.slice(0, 8)}`);
  });

  it("nests a workflow job's scripts under <project>/<job-leaf> (no agent segment)", () => {
    const project = createProject("Ops")!;
    const workflow = createWorkflow(project.id, {
      name: "Health Check",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const run = createRun(workflow.id, null)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.job.scripts_dir).toBe(`ops/health-check-${workflow.id.slice(0, 8)}`);
  });

  it("keeps the job-leaf's id suffix stable across job renames", () => {
    const project = createProject("Ops")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;
    const suffix = job.id.slice(0, 8);

    expect(buildRunPayload(run.id)!.job.scripts_dir).toBe(`ops/dev/build-${suffix}`);

    // The leaf's name segment follows the current job name, but the id suffix
    // pins the directory identity — no collision with a sibling job.
    updateJob(job.id, { name: "Build v2" });
    expect(buildRunPayload(run.id)!.job.scripts_dir).toBe(`ops/dev/build-v2-${suffix}`);
  });
});
