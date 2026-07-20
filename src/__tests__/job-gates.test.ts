import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createProject,
  createRun,
  createWorkflow,
  getJobById,
  updateJob,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Job gate storage + payload shape. Gates (prerun / postrun / a workflow's
// command) are "gist" scripts: { runtime, content }. This suite covers how the
// DB layer persists each gate's runtime + body and how buildRunPayload exposes
// them as objects. Postrun *behavior* (the enforcing flag) lives in
// jobs-postrun.test.ts and is not duplicated here.
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

function agentJob(data: Parameters<typeof createJob>[2]) {
  const project = createProject("Website")!;
  const agent = createAgent(project.id, "Dev");
  return createJob(project.id, agent.id, data)!;
}

// ---------------------------------------------------------------------------
// createJob — prerun / postrun gate storage (runtime + body round-trip)
// ---------------------------------------------------------------------------
describe("createJob: gate storage", () => {
  it("persists prerun and postrun runtime + script", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      prerun: { runtime: "python", content: "print(1)" },
      postrun: { runtime: "bash", content: "echo done" },
    });

    const fresh = getJobById(job.id);
    expect(fresh.prerun_runtime).toBe("python");
    expect(fresh.prerun_script).toBe("print(1)");
    expect(fresh.postrun_runtime).toBe("bash");
    expect(fresh.postrun_script).toBe("echo done");
  });

  it("leaves all gate columns NULL when no gates are given", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });

    const fresh = getJobById(job.id);
    expect(fresh.prerun_runtime).toBeNull();
    expect(fresh.prerun_script).toBeNull();
    expect(fresh.postrun_runtime).toBeNull();
    expect(fresh.postrun_script).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateJob — set / clear the prerun gate
// ---------------------------------------------------------------------------
describe("updateJob: prerun gate", () => {
  it("clears prerun_runtime + prerun_script to NULL when prerun is null", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      prerun: { runtime: "python", content: "print(1)" },
    });

    updateJob(job.id, { prerun: null });

    const fresh = getJobById(job.id);
    expect(fresh.prerun_runtime).toBeNull();
    expect(fresh.prerun_script).toBeNull();
  });

  it("sets prerun_runtime + prerun_script from a gate object", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });

    updateJob(job.id, { prerun: { runtime: "node", content: "x" } });

    const fresh = getJobById(job.id);
    expect(fresh.prerun_runtime).toBe("node");
    expect(fresh.prerun_script).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// createWorkflow — workflow gate storage
// ---------------------------------------------------------------------------
describe("createWorkflow: gate storage", () => {
  it("persists workflow_runtime + workflow_script", () => {
    const project = createProject("Site")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;

    const fresh = getJobById(wf.id);
    expect(fresh.workflow_runtime).toBe("bash");
    expect(fresh.workflow_script).toBe("echo hi");
  });
});

// ---------------------------------------------------------------------------
// buildRunPayload — gates surface as objects, scripts_dir present, no scripts
// ---------------------------------------------------------------------------
describe("buildRunPayload: gate shape", () => {
  it("exposes job.prerun / job.postrun as gate objects for an agent run", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      prerun: { runtime: "python", content: "print(1)" },
      postrun: { runtime: "bash", content: "echo done" },
    });
    const run = createRun(job.id, job.agent_id)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.job.prerun).toEqual({ runtime: "python", content: "print(1)" });
    expect(payload.job.postrun).toEqual({ runtime: "bash", content: "echo done" });

    // The flat `scripts` array is gone; scripts_dir is kept.
    expect((payload.job as Record<string, unknown>).scripts).toBeUndefined();
    expect("scripts_dir" in payload.job).toBe(true);
  });

  it("exposes job.prerun as null when the agent job has no prerun gate", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });
    const run = createRun(job.id, job.agent_id)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.job.prerun).toBeNull();
    expect(payload.job.postrun).toBeNull();
  });

  it("aliases command and workflow to the same gate object for a workflow run", () => {
    const project = createProject("Site")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo sync" },
    })!;
    const run = createRun(wf.id, null)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.job.command).toEqual({ runtime: "bash", content: "echo sync" });
    expect(payload.job.workflow).toEqual({ runtime: "bash", content: "echo sync" });
    expect(payload.job.command).toEqual(payload.job.workflow);
  });
});
