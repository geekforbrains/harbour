import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveOrg,
  archiveProject,
  buildRunPayload,
  createAgent,
  createJob,
  createOrg,
  createProject,
  createRun,
  createWorkflow,
  getAgentWorkspace,
  updateAgent,
  updateOrg,
  updateProject,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

// ---------------------------------------------------------------------------
// Workspace slugs (issue #40) — orgs, projects, and agents get a slug at
// creation time, immutable on rename, unique per scope (org: instance-wide,
// project: per-org, agent: per-project). The run payload carries the three
// slugs so runners nest workspace dirs as workspaces/<org>/<project>/<agent>
// instead of a flat display-name-derived folder two same-named agents in
// different projects would silently share.
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
  it("sets the slug on orgs, projects, and agents from the name", () => {
    const org = createOrg("  My  Org!! ")!;
    expect(org.slug).toBe("my-org");

    const project = createProject(org.id, "Dev_Project")!;
    expect(project.slug).toBe("dev-project");

    const agent = createAgent(project.id, "Dev Agent");
    expect(agent.slug).toBe("dev-agent");
  });

  it("rejects names with no letters or numbers at every scope", () => {
    expect(() => createOrg("日本語")).toThrow(InvalidNameError);

    const org = createOrg("Acme")!;
    expect(() => createProject(org.id, "!!!")).toThrow(InvalidNameError);

    const project = createProject(org.id, "Website")!;
    expect(() => createAgent(project.id, "🚀🚀")).toThrow(InvalidNameError);
  });
});

describe("slug uniqueness scopes", () => {
  it("org slugs are unique instance-wide, lookalikes included", () => {
    createOrg("Acme");
    expect(() => createOrg("acme")).toThrow(NameCollisionError);
    expect(() => createOrg("  ACME!! ")).toThrow(NameCollisionError);
  });

  it("an archived org still blocks its slug (its workspace dirs may linger on runners)", () => {
    const org = createOrg("Acme")!;
    archiveOrg(org.id);
    expect(() => createOrg("Acme")).toThrow(NameCollisionError);
  });

  it("project slugs are unique per org; the same name works in another org", () => {
    const a = createOrg("Org A")!;
    const b = createOrg("Org B")!;
    createProject(a.id, "Website");
    expect(() => createProject(a.id, "WEBSITE!")).toThrow(NameCollisionError);
    expect(createProject(b.id, "Website")!.slug).toBe("website");
  });

  it("an archived project still blocks its slug within the org", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    archiveProject(project.id);
    expect(() => createProject(org.id, "Website")).toThrow(NameCollisionError);
  });

  it("agent slugs are unique per project; the same name works in a sibling project", () => {
    const org = createOrg("Acme")!;
    const p1 = createProject(org.id, "Website")!;
    const p2 = createProject(org.id, "Mobile")!;
    createAgent(p1.id, "Dev Agent");
    // The lookalike that motivated the feature: different display name, same slug.
    expect(() => createAgent(p1.id, "Dev_Agent")).toThrow(NameCollisionError);
    expect(createAgent(p2.id, "Dev Agent").slug).toBe("dev-agent");
  });

  it("collision errors name the existing entity for the dialog", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    createAgent(project.id, "Dev Agent");
    expect(() => createAgent(project.id, "Dev_Agent")).toThrow(
      /An agent named "Dev Agent" already exists in this project/,
    );
  });
});

describe("slugs are immutable on rename", () => {
  it("updateOrg/updateProject/updateAgent change the name but keep the slug", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev Agent");

    const renamedOrg = updateOrg(org.id, { name: "Acme Corp" });
    expect(renamedOrg.name).toBe("Acme Corp");
    expect(renamedOrg.slug).toBe("acme");

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
    const org = createOrg("  My  Org!! ")!;
    const project = createProject(org.id, "Dev_Project")!;
    const agent = createAgent(project.id, "Dev Agent");
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;
    return { org, project, agent, run };
  }

  it("carries the org/project/agent slugs for an agent run", () => {
    const { run } = agentRunPayload();
    const payload = buildRunPayload(run.id)!;
    expect(payload.workspace).toEqual({
      org: "my-org",
      project: "dev-project",
      agent: "dev-agent",
    });
  });

  it("keeps the original slugs after renames — workspace paths stay stable", () => {
    const { org, project, agent, run } = agentRunPayload();
    updateOrg(org.id, { name: "Renamed Org" });
    updateProject(project.id, { name: "Renamed Project" });
    updateAgent(agent.id, { name: "Renamed Agent" });

    const payload = buildRunPayload(run.id)!;
    expect(payload.workspace).toEqual({
      org: "my-org",
      project: "dev-project",
      agent: "dev-agent",
    });
  });

  it("omits the workspace key for a workflow run (no agent, no CLI, no workspace)", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Ops")!;
    const workflow = createWorkflow(org.id, project.id, {
      name: "Health Check",
      schedule: '{"every":60}',
      command: "echo hi",
    })!;
    const run = createRun(workflow.id, null)!;
    const payload = buildRunPayload(run.id)!;
    expect("workspace" in payload).toBe(false);
  });

  it("getAgentWorkspace returns null for an unknown agent", () => {
    expect(getAgentWorkspace("nope")).toBeNull();
  });
});
