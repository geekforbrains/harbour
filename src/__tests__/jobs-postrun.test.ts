import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent, createJob, createProject, getJobById, updateJob } from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Postrun gate (#29) schema round-trip: createJob / getJobById / updateJob must
// persist and return postrun_script + postrun_gates, mirroring prerun_script.
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

describe("createJob — postrun fields", () => {
  it("defaults to no postrun command and gates off", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });
    expect(job.postrun_script).toBeNull();
    expect(job.postrun_gates).toBe(0);
  });

  it("persists a postrun command (informational by default)", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrun: { runtime: "bash", content: "bash cleanup.sh" },
    });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_script).toBe("bash cleanup.sh");
    expect(fresh.postrun_gates).toBe(0);
  });

  it("persists the enforcing flag alongside the command", () => {
    const job = agentJob({
      name: "Verify",
      schedule: '{"every":60}',
      postrun: { runtime: "bash", content: "bash verify.sh" },
      postrunGates: true,
    });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_script).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });

  it("stores no postrun gate as NULL (no-op gate)", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}', postrun: null });
    expect(getJobById(job.id).postrun_script).toBeNull();
  });
});

describe("updateJob — postrun fields", () => {
  it("sets a postrun command and the enforcing flag", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });
    updateJob(job.id, {
      postrun: { runtime: "bash", content: "bash verify.sh" },
      postrunGates: true,
    });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_script).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });

  it("clears the postrun command back to NULL when set null", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrun: { runtime: "bash", content: "bash verify.sh" },
    });
    updateJob(job.id, { postrun: null });
    expect(getJobById(job.id).postrun_script).toBeNull();
  });

  it("toggles the enforcing flag without touching the command", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrun: { runtime: "bash", content: "bash verify.sh" },
      postrunGates: true,
    });
    updateJob(job.id, { postrunGates: false });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_script).toBe("bash verify.sh"); // untouched
    expect(fresh.postrun_gates).toBe(0);
  });

  it("leaves postrun fields untouched when neither is in the update", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrun: { runtime: "bash", content: "bash verify.sh" },
      postrunGates: true,
    });
    updateJob(job.id, { name: "Renamed" });
    const fresh = getJobById(job.id);
    expect(fresh.name).toBe("Renamed");
    expect(fresh.postrun_script).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });
});
