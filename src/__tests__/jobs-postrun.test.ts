import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createJob,
  createOrg,
  createProject,
  getJobById,
  updateJob,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Postrun gate (#29) schema round-trip: createJob / getJobById / updateJob must
// persist and return postrun_command + postrun_gates, mirroring prerun_command.
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
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Website")!;
  const agent = createAgent(project.id, "Dev");
  return createJob(project.id, agent.id, data)!;
}

describe("createJob — postrun fields", () => {
  it("defaults to no postrun command and gates off", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });
    expect(job.postrun_command).toBeNull();
    expect(job.postrun_gates).toBe(0);
  });

  it("persists a postrun command (informational by default)", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrunCommand: "bash cleanup.sh",
    });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_command).toBe("bash cleanup.sh");
    expect(fresh.postrun_gates).toBe(0);
  });

  it("persists the enforcing flag alongside the command", () => {
    const job = agentJob({
      name: "Verify",
      schedule: '{"every":60}',
      postrunCommand: "bash verify.sh",
      postrunGates: true,
    });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_command).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });

  it("stores an empty postrun command as NULL (no-op gate)", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}', postrunCommand: "" });
    expect(getJobById(job.id).postrun_command).toBeNull();
  });
});

describe("updateJob — postrun fields", () => {
  it("sets a postrun command and the enforcing flag", () => {
    const job = agentJob({ name: "Build", schedule: '{"every":60}' });
    updateJob(job.id, { postrunCommand: "bash verify.sh", postrunGates: true });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_command).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });

  it("clears the postrun command back to NULL when set empty", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrunCommand: "bash verify.sh",
    });
    updateJob(job.id, { postrunCommand: "" });
    expect(getJobById(job.id).postrun_command).toBeNull();
  });

  it("toggles the enforcing flag without touching the command", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrunCommand: "bash verify.sh",
      postrunGates: true,
    });
    updateJob(job.id, { postrunGates: false });
    const fresh = getJobById(job.id);
    expect(fresh.postrun_command).toBe("bash verify.sh"); // untouched
    expect(fresh.postrun_gates).toBe(0);
  });

  it("leaves postrun fields untouched when neither is in the update", () => {
    const job = agentJob({
      name: "Build",
      schedule: '{"every":60}',
      postrunCommand: "bash verify.sh",
      postrunGates: true,
    });
    updateJob(job.id, { name: "Renamed" });
    const fresh = getJobById(job.id);
    expect(fresh.name).toBe("Renamed");
    expect(fresh.postrun_command).toBe("bash verify.sh");
    expect(fresh.postrun_gates).toBe(1);
  });
});
