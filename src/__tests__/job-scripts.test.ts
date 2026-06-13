import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createJobScript,
  createOrg,
  createProject,
  createRun,
  createWorkflow,
  deleteJob,
  deleteJobScript,
  getJobScriptsDir,
  getJobScriptsForPayload,
  listJobScripts,
  updateJobScript,
  validateScriptFilename,
} from "@/lib/db/queries";
import { getDb, initializeSchema, isUniqueViolation, resetDb, setDb } from "@/lib/db/schema";

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

const SCHEDULE = '{"every":60}';

function agentJobFixture() {
  const org = createOrg("  My  Org!! ")!;
  const project = createProject(org.id, "Dev_Project")!;
  const agent = createAgent(project.id, "Dev Agent");
  const job = createJob(project.id, agent.id, { name: "Build Site", schedule: SCHEDULE })!;
  return { org, project, agent, job };
}

// ===========================================================================
// validateScriptFilename — bare names only, no path traversal
// ===========================================================================

describe("validateScriptFilename", () => {
  it("accepts ordinary script names", () => {
    for (const name of [
      "prerun.sh",
      "check_health.py",
      "ok-name.sh",
      "a",
      "A1.b-c_d",
      "x".repeat(128),
    ]) {
      expect(validateScriptFilename(name)).toBe(name);
    }
  });

  it("rejects . and .. (directory entries, not files)", () => {
    expect(() => validateScriptFilename(".")).toThrow();
    expect(() => validateScriptFilename("..")).toThrow();
  });

  it("rejects anything with a slash (no path traversal)", () => {
    expect(() => validateScriptFilename("a/b")).toThrow();
    expect(() => validateScriptFilename("../etc/passwd")).toThrow();
    expect(() => validateScriptFilename("dir\\file")).toThrow();
  });

  it("rejects empty, overlong, and out-of-charset names", () => {
    expect(() => validateScriptFilename("")).toThrow();
    expect(() => validateScriptFilename("x".repeat(129))).toThrow();
    expect(() => validateScriptFilename("space name.sh")).toThrow();
    expect(() => validateScriptFilename("emoji🚀.sh")).toThrow();
  });
});

// ===========================================================================
// CRUD + constraints
// ===========================================================================

describe("job scripts CRUD", () => {
  it("creates, lists, and defaults executable to true with empty content", () => {
    const { job } = agentJobFixture();
    const s = createJobScript({ jobId: job.id, filename: "prerun.sh" });
    expect(s.filename).toBe("prerun.sh");
    expect(s.content).toBe("");
    expect(s.executable).toBe(1);
    expect(s.created_at).toBeTypeOf("number");
    expect(s.updated_at).toBeTypeOf("number");

    const list = listJobScripts(job.id);
    expect(list.map((x) => x.id)).toEqual([s.id]);
  });

  it("honors explicit content and executable=false", () => {
    const { job } = agentJobFixture();
    const s = createJobScript({
      jobId: job.id,
      filename: "data.json",
      content: "{}",
      executable: false,
    });
    expect(s.content).toBe("{}");
    expect(s.executable).toBe(0);
  });

  it("validates the filename on create", () => {
    const { job } = agentJobFixture();
    expect(() => createJobScript({ jobId: job.id, filename: "../escape.sh" })).toThrow();
  });

  it("updates filename/content/executable and validates the new filename", () => {
    const { job } = agentJobFixture();
    const s = createJobScript({ jobId: job.id, filename: "old.sh", content: "a" });
    const updated = updateJobScript(s.id, {
      filename: "new.sh",
      content: "b",
      executable: false,
    })!;
    expect(updated.filename).toBe("new.sh");
    expect(updated.content).toBe("b");
    expect(updated.executable).toBe(0);

    expect(() => updateJobScript(s.id, { filename: "no/slash" })).toThrow();
  });

  it("deletes a single script", () => {
    const { job } = agentJobFixture();
    const s = createJobScript({ jobId: job.id, filename: "gone.sh" });
    deleteJobScript(s.id);
    expect(listJobScripts(job.id)).toEqual([]);
  });

  it("enforces UNIQUE(job_id, filename)", () => {
    const { job } = agentJobFixture();
    createJobScript({ jobId: job.id, filename: "dup.sh" });
    try {
      createJobScript({ jobId: job.id, filename: "dup.sh" });
      expect.unreachable("second insert with same (job_id, filename) should throw");
    } catch (err) {
      expect(isUniqueViolation(err)).toBe(true);
    }
  });

  it("allows the same filename across different jobs", () => {
    const { project, agent, job } = agentJobFixture();
    const job2 = createJob(project.id, agent.id, { name: "Second Job", schedule: SCHEDULE })!;
    expect(() => createJobScript({ jobId: job.id, filename: "shared.sh" })).not.toThrow();
    expect(() => createJobScript({ jobId: job2.id, filename: "shared.sh" })).not.toThrow();
  });

  it("cascades on job delete (ON DELETE CASCADE)", () => {
    const { job } = agentJobFixture();
    createJobScript({ jobId: job.id, filename: "a.sh" });
    createJobScript({ jobId: job.id, filename: "b.sh" });
    deleteJob(job.id);
    const remaining = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM job_scripts WHERE job_id = ?`)
      .get(job.id) as { n: number };
    expect(remaining.n).toBe(0);
  });
});

// ===========================================================================
// getJobScriptsForPayload — payload shape
// ===========================================================================

describe("getJobScriptsForPayload", () => {
  it("returns empty array when the job has no scripts", () => {
    const { job } = agentJobFixture();
    expect(getJobScriptsForPayload(job.id)).toEqual([]);
  });

  it("returns {filename, content, executable:boolean} sorted by filename", () => {
    const { job } = agentJobFixture();
    createJobScript({ jobId: job.id, filename: "b.sh", content: "B", executable: false });
    createJobScript({ jobId: job.id, filename: "a.sh", content: "A" });
    expect(getJobScriptsForPayload(job.id)).toEqual([
      { filename: "a.sh", content: "A", executable: true },
      { filename: "b.sh", content: "B", executable: false },
    ]);
  });
});

// ===========================================================================
// scripts_dir — server-side relative path per tier
// ===========================================================================

describe("getJobScriptsDir", () => {
  it("agent job: <org>/<project>/<agent>/<job-leaf>", () => {
    const { job } = agentJobFixture();
    const dir = getJobScriptsDir(job.id)!;
    expect(dir).toBe(`my-org/dev-project/dev-agent/build-site-${job.id.slice(0, 8)}`);
  });

  it("project workflow: <org>/<project>/<job-leaf>", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Ops")!;
    const wf = createWorkflow(org.id, project.id, {
      name: "Health Check",
      schedule: SCHEDULE,
      command: "./check.sh",
    })!;
    expect(getJobScriptsDir(wf.id)).toBe(`acme/ops/health-check-${wf.id.slice(0, 8)}`);
  });

  it("org-level workflow: <org>/<job-leaf> (no project tier)", () => {
    const org = createOrg("Acme")!;
    const wf = createWorkflow(org.id, null, {
      name: "Nightly Sweep",
      schedule: SCHEDULE,
      command: "./sweep.sh",
    })!;
    expect(getJobScriptsDir(wf.id)).toBe(`acme/nightly-sweep-${wf.id.slice(0, 8)}`);
  });

  it("stays stable across a job rename (leaf uses the immutable id)", () => {
    const org = createOrg("Acme")!;
    const wf = createWorkflow(org.id, null, {
      name: "Nightly Sweep",
      schedule: SCHEDULE,
      command: "./sweep.sh",
    })!;
    const before = getJobScriptsDir(wf.id);
    getDb().prepare(`UPDATE jobs SET name = ? WHERE id = ?`).run("Renamed Sweep", wf.id);
    // The leaf id suffix is unchanged; only slug(name) would move, which we
    // deliberately recompute — assert the id suffix is stable across renames.
    expect(getJobScriptsDir(wf.id)).toBe(`acme/renamed-sweep-${wf.id.slice(0, 8)}`);
    expect(before).toContain(wf.id.slice(0, 8));
  });

  it("returns null for an unknown job", () => {
    expect(getJobScriptsDir("nope")).toBeNull();
  });
});

// ===========================================================================
// buildRunPayload — job block carries scripts + scripts_dir
// ===========================================================================

describe("buildRunPayload scripts", () => {
  it("agent run: includes scripts and a correctly formatted scripts_dir", () => {
    const { agent, job } = agentJobFixture();
    createJobScript({
      jobId: job.id,
      filename: "prerun.sh",
      content: "#!/bin/sh\n",
      executable: true,
    });
    const run = createRun(job.id, agent.id)!;
    const payload = buildRunPayload(run.id)!;

    expect(payload.job.scripts).toEqual([
      { filename: "prerun.sh", content: "#!/bin/sh\n", executable: true },
    ]);
    expect(payload.job.scripts_dir).toBe(
      `my-org/dev-project/dev-agent/build-site-${job.id.slice(0, 8)}`,
    );
  });

  it("org-level workflow run: empty scripts array and org-tier scripts_dir", () => {
    const org = createOrg("Acme")!;
    const wf = createWorkflow(org.id, null, {
      name: "Nightly Sweep",
      schedule: SCHEDULE,
      command: "./sweep.sh",
    })!;
    const run = createRun(wf.id, null)!;
    const payload = buildRunPayload(run.id)!;

    expect(payload.job.scripts).toEqual([]);
    expect(payload.job.scripts_dir).toBe(`acme/nightly-sweep-${wf.id.slice(0, 8)}`);
  });
});
