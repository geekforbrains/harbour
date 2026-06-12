import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateWorkflowRunner,
  buildRunPayload,
  createDatabase,
  createDoc,
  createEnvVar,
  createOrg,
  createProject,
  createRun,
  createWorkflow,
  createWorkflowRunner,
  getNextWorkflowRun,
  getRunById,
  insertRows,
  linkDatabaseToJob,
  listRunActivity,
  peekWorkflowNext,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Setup / Teardown — fresh in-memory v2 DB per test (mirrors the other suites)
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

const HOUR_AGO = () => Math.floor(Date.now() / 1000) - 3600;

function workflowJob(active = true) {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const wf = createWorkflow(org.id, project.id, {
    name: "Sync",
    schedule: '{"every":60}',
    command: "echo sync",
    active,
  })!;
  return { org, project, wf };
}

/** Force a job to be due now by backdating its next_run_at. */
function makeJobDue(jobId: string) {
  getDb().prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`).run(HOUR_AGO(), jobId);
}

function runsForJob(jobId: string) {
  return getDb().prepare(`SELECT id, status FROM runs WHERE job_id = ?`).all(jobId) as {
    id: string;
    status: string;
  }[];
}

// ---------------------------------------------------------------------------
// getNextWorkflowRun — recurring-job materialization + NOT EXISTS de-dup
// ---------------------------------------------------------------------------
describe("getNextWorkflowRun: recurring workflow job materialization", () => {
  it("materializes a run from a due recurring workflow job and advances its schedule", () => {
    const { org, wf } = workflowJob();
    makeJobDue(wf.id);

    const payload = getNextWorkflowRun(org.id)!;
    expect(payload).toBeTruthy();
    expect(payload.job.kind).toBe("workflow");
    expect(payload.job.command).toBe("echo sync");

    // A single run was materialized and claimed as running.
    const runs = runsForJob(wf.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("running");

    // Schedule advanced past now so the job won't immediately re-fire.
    const job = getDb().prepare(`SELECT next_run_at FROM jobs WHERE id = ?`).get(wf.id) as {
      next_run_at: number;
    };
    expect(job.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("NOT EXISTS guard: does not re-fire while an active (running) run exists", () => {
    const { org, wf } = workflowJob();
    makeJobDue(wf.id);

    // First poll materializes a running run.
    expect(getNextWorkflowRun(org.id)).toBeTruthy();
    expect(runsForJob(wf.id).length).toBe(1);

    // Re-backdate the job so the schedule alone would make it due again — the
    // only thing that should suppress a second run is the active run guard.
    makeJobDue(wf.id);
    const second = getNextWorkflowRun(org.id);

    expect(second).toBeNull();
    expect(runsForJob(wf.id).length).toBe(1); // no duplicate run
  });

  it("does not materialize a run for an inactive workflow job", () => {
    const { org, wf } = workflowJob(false);
    makeJobDue(wf.id); // even if forced due, active = 0 excludes it
    getDb().prepare(`UPDATE jobs SET active = 0 WHERE id = ?`).run(wf.id);

    expect(getNextWorkflowRun(org.id)).toBeNull();
    expect(runsForJob(wf.id).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getNextWorkflowRun — scheduled claim (verifies the guarded claim still works)
// ---------------------------------------------------------------------------
describe("getNextWorkflowRun: scheduled run claim", () => {
  it("claims a due scheduled workflow run and flips it to running", () => {
    const { org, wf } = workflowJob();
    const run = createRun(wf.id, null)!;
    // createRun starts a run as 'running'; rewind it to a due 'scheduled' run.
    getDb()
      .prepare(`UPDATE runs SET status = 'scheduled', scheduled_for = ? WHERE id = ?`)
      .run(HOUR_AGO(), run.id);

    const payload = getNextWorkflowRun(org.id)!;
    expect(payload.run.id).toBe(run.id);
    expect(getRunById(run.id)!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Stale-run timeout-fail — present in getNextWorkflowRun, absent in peek
// ---------------------------------------------------------------------------
describe("workflow stale-run reaping", () => {
  function staleRunningRun() {
    const { org, wf } = workflowJob();
    const run = createRun(wf.id, null)!; // status 'running'
    // Backdate claimed_at well past the job's 30-min hard cap. updated_at stays
    // recent on purpose: the reaper is a claimed_at ceiling (issue #15), not an
    // inactivity check, so a chatty-but-overrunning run is still reaped.
    getDb()
      .prepare(`UPDATE runs SET claimed_at = ?, updated_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 4000, Math.floor(Date.now() / 1000), run.id);
    return { org, wf, run };
  }

  it("getNextWorkflowRun fails a run that ran past its timeout and records a system note", () => {
    const { org, run } = staleRunningRun();

    getNextWorkflowRun(org.id);

    expect(getRunById(run.id)!.status).toBe("failed");
    const activity = listRunActivity(run.id);
    expect(activity.some((a) => a.author_type === "system" && /timed out/i.test(a.content))).toBe(
      true,
    );
  });

  it("peekWorkflowNext is read-only — it does NOT reap a stale run", () => {
    const { org, run } = staleRunningRun();

    const peek = peekWorkflowNext(org.id);

    expect(getRunById(run.id)!.status).toBe("running"); // untouched
    expect(peek.available).toBe(false);
    expect(peek.reason).toBe("nothing_to_do");
  });
});

// ---------------------------------------------------------------------------
// buildRunPayload — full workflow shape: composes resources, no agent block
// ---------------------------------------------------------------------------
describe("buildRunPayload: workflow run shape", () => {
  it("composes docs/data/env, carries the command, and omits the agent block + title preamble", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;

    const doc = createDoc(org.id, project.id, "Runbook", "do the thing")!;
    const env = createEnvVar(org.id, project.id, "API_TOKEN", "secret")!;

    const wf = createWorkflow(org.id, project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      command: "echo sync",
      docIds: [doc.id],
      envVarIds: [env.id],
    })!;

    const data = createDatabase(org.id, project.id, "metrics", [{ name: "v", type: "TEXT" }]);
    insertRows(data.id, [{ v: "row-1" }]);
    linkDatabaseToJob(wf.id, data.id);

    const run = createRun(wf.id, null)!;
    const payload = buildRunPayload(run.id)!;

    // Workflow identity + command
    expect(payload.job.kind).toBe("workflow");
    expect(payload.job.command).toBe("echo sync");
    expect(payload.job.workflow).toBe("echo sync");

    // No agent block, and no agent-only title preamble injected into instructions
    expect(payload.agent).toBeUndefined();
    expect(payload.job.instructions).toBeNull();

    // Resources compose for a workflow run just like an agent run
    expect(payload.docs.map((d) => d.id)).toContain(doc.id);
    expect(payload.env.API_TOKEN).toBe("secret");
    expect(payload.data.metrics.rows).toEqual([expect.objectContaining({ v: "row-1" })]);
  });
});

// ---------------------------------------------------------------------------
// authenticateWorkflowRunner — disabled runners must be rejected
// ---------------------------------------------------------------------------
describe("authenticateWorkflowRunner", () => {
  it("authenticates an enabled runner and rejects it once disabled", () => {
    const org = createOrg("Acme")!;
    const runner = createWorkflowRunner(org.id, "CI");

    expect(authenticateWorkflowRunner(runner.apiKey)?.id).toBe(runner.id);

    getDb().prepare(`UPDATE workflow_runners SET enabled = 0 WHERE id = ?`).run(runner.id);

    expect(authenticateWorkflowRunner(runner.apiKey)).toBeNull();
  });

  it("rejects an unknown key", () => {
    createOrg("Acme");
    expect(authenticateWorkflowRunner("hwf_nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claim-race hardening — the guarded UPDATE makes a lost claim a no-op
// ---------------------------------------------------------------------------
describe("claim-race guard", () => {
  it("a guarded scheduled-claim UPDATE only wins once (second attempt is a no-op)", () => {
    // Mirrors the claim guard in getNextWorkflowRun/getAgentNextRun: two runners
    // can both SELECT a 'scheduled' run, but only the one whose UPDATE still sees
    // status='scheduled' wins. The loser sees changes === 0 and backs off.
    const { wf } = workflowJob();
    const run = createRun(wf.id, null)!;
    const db = getDb();
    db.prepare(`UPDATE runs SET status = 'scheduled' WHERE id = ?`).run(run.id);

    const claim = `UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'scheduled'`;
    const first = db.prepare(claim).run(run.id);
    const second = db.prepare(claim).run(run.id);

    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
    expect(getRunById(run.id)!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// busy_timeout — set on the real connection so a contended claim waits rather
// than failing immediately with SQLITE_BUSY. Exercises getDb()'s init path.
// ---------------------------------------------------------------------------
describe("getDb busy_timeout pragma", () => {
  it("sets busy_timeout = 5000 on a freshly opened connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-busy-"));
    const prev = process.env.HARBOUR_DB_PATH;
    process.env.HARBOUR_DB_PATH = join(dir, "harbour.db");
    try {
      resetDb(); // drop the in-memory test db so getDb opens the real path
      const db = getDb();
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      resetDb();
      if (prev === undefined) delete process.env.HARBOUR_DB_PATH;
      else process.env.HARBOUR_DB_PATH = prev;
    }
  });
});
