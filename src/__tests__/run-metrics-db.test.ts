import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRunUsage,
  createAgent,
  createJob,
  createProject,
  createRun,
  createWorkflow,
  failTimedOutRun,
  getJobById,
  listAllJobs,
  listJobsByAgent,
  triggerJobRun,
  updateRunStatus,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { claim } from "./support/claim";

// ---------------------------------------------------------------------------
// Per-run cumulative metrics: attempts, duration_seconds, input_tokens,
// output_tokens.
//
// The contract: attempts counts running attempts started (birth/claim + each
// pending→running resume); duration_seconds is agent WORKING time only — it
// accumulates `now − claimed_at` every time a running attempt ends, so time
// parked in waiting/pending is excluded by construction; token counters are
// additive deltas reported per CLI turn via addRunUsage. All four are
// cumulative across the run's whole life and never reset — a retried run keeps
// accumulating, which is the point.
//
// Duration tests backdate claimed_at with raw SQL to get a measurable delta,
// and assert with slop (>= 118 for a 120s backdate) rather than exact equality
// since unixepoch() advances between statements.
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

function agentSetup() {
  const project = createProject("Website")!;
  // A CLI is required for a CLI runner to claim/resume the agent's runs.
  const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  return { project, agent, job };
}

function backdateClaim(runId: string, seconds: number) {
  getDb().prepare(`UPDATE runs SET claimed_at = unixepoch() - ? WHERE id = ?`).run(seconds, runId);
}

function metricsOf(runId: string) {
  return getDb()
    .prepare(
      `SELECT attempts, duration_seconds, input_tokens, output_tokens FROM runs WHERE id = ?`,
    )
    .get(runId) as {
    attempts: number;
    duration_seconds: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// ===========================================================================
// DDL defaults — the manual-ALTER upgrade path backfills existing rows with 0
// ===========================================================================

describe("metrics columns default to 0", () => {
  it("a bare INSERT (rows predating the columns) reads 0 for all four", () => {
    const { project, job } = agentSetup();
    getDb()
      .prepare(`INSERT INTO runs (id, project_id, job_id, status) VALUES ('r-old', ?, ?, 'done')`)
      .run(project.id, job.id);
    expect(metricsOf("r-old")).toEqual({
      attempts: 0,
      duration_seconds: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

// ===========================================================================
// Attempts — incremented at every claimed_at stamp site
// ===========================================================================

describe("attempts", () => {
  it("createRun starts at attempt 1 (born running)", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    expect(run.attempts).toBe(1);
  });

  it("claiming a scheduled run counts its first attempt", () => {
    const { job } = agentSetup();
    const { runId } = triggerJobRun(job.id)!; // INSERTed 'scheduled', attempts 0
    expect(metricsOf(runId).attempts).toBe(0);
    claim(); // claimUpdate: scheduled → running
    expect(metricsOf(runId).attempts).toBe(1);
  });

  it("a pending → running re-claim counts a new attempt", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    updateRunStatus(run.id, "waiting");
    updateRunStatus(run.id, "pending");
    claim(); // claimUpdate: pending → running
    expect(metricsOf(run.id).attempts).toBe(2);
  });

  it("updateRunStatus entering running counts a new attempt (status-route path)", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    updateRunStatus(run.id, "waiting");
    updateRunStatus(run.id, "pending");
    updateRunStatus(run.id, "running");
    expect(metricsOf(run.id).attempts).toBe(2);
  });
});

// ===========================================================================
// Duration — accumulates when (and only when) a running attempt ends
// ===========================================================================

describe("duration accumulation", () => {
  it.each([
    "waiting",
    "done",
    "failed",
    "skipped",
    "killed",
  ] as const)("running → %s folds the attempt's elapsed time into duration_seconds", (exit) => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 120);
    updateRunStatus(run.id, exit);
    const duration = metricsOf(run.id).duration_seconds;
    expect(duration).toBeGreaterThanOrEqual(118);
    expect(duration).toBeLessThanOrEqual(130);
  });

  it("waiting → pending adds nothing (claimed_at present but the run wasn't executing)", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 120);
    updateRunStatus(run.id, "waiting");
    const parked = metricsOf(run.id).duration_seconds;
    updateRunStatus(run.id, "pending");
    expect(metricsOf(run.id).duration_seconds).toBe(parked);
  });

  it("accumulates across a full waiting → pending → running → done cycle", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 120);
    updateRunStatus(run.id, "waiting"); // first attempt ends: +~120s
    updateRunStatus(run.id, "pending");
    updateRunStatus(run.id, "running"); // second attempt: claimed_at re-stamped
    backdateClaim(run.id, 60);
    updateRunStatus(run.id, "done"); // second attempt ends: +~60s
    const metrics = metricsOf(run.id);
    expect(metrics.duration_seconds).toBeGreaterThanOrEqual(178);
    expect(metrics.duration_seconds).toBeLessThanOrEqual(195);
    expect(metrics.attempts).toBe(2);
  });

  it("failTimedOutRun (timeout sweeper bypasses the chokepoint) accumulates too", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 120);
    expect(failTimedOutRun(run.id, 30)).toBe(true);
    const metrics = metricsOf(run.id);
    expect(metrics.duration_seconds).toBeGreaterThanOrEqual(118);
    expect(metrics.duration_seconds).toBeLessThanOrEqual(130);
  });

  it("workflow runs accumulate duration and attempts the same way; tokens stay 0", () => {
    const project = createProject("Ops")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo sync" },
    })!;
    const run = createRun(wf.id, null)!;
    backdateClaim(run.id, 120);
    updateRunStatus(run.id, "done");
    const metrics = metricsOf(run.id);
    expect(metrics.attempts).toBe(1);
    expect(metrics.duration_seconds).toBeGreaterThanOrEqual(118);
    expect(metrics.input_tokens).toBe(0);
    expect(metrics.output_tokens).toBe(0);
  });
});

// ===========================================================================
// addRunUsage — additive token deltas, one UPDATE per CLI turn
// ===========================================================================

describe("addRunUsage", () => {
  it("accumulates across calls (per-turn deltas, server sums)", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    addRunUsage(run.id, { input_tokens: 1000, output_tokens: 200 });
    const updated = addRunUsage(run.id, { input_tokens: 500, output_tokens: 50 });
    expect(updated?.input_tokens).toBe(1500);
    expect(updated?.output_tokens).toBe(250);
    expect(metricsOf(run.id)).toMatchObject({ input_tokens: 1500, output_tokens: 250 });
  });

  it("returns null for an unknown run", () => {
    expect(addRunUsage("nope", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

// ===========================================================================
// Job rollups — which jobs burn the most time and tokens
// ===========================================================================

// The rollup columns the jobs queries append; the query layer returns untyped
// rows (better-sqlite3 boundary), so narrow to what these assertions read.
type JobRollup = {
  id: string;
  total_duration_seconds: number;
  total_tokens: number;
  measured_duration_seconds: number;
  measured_runs: number;
};

describe("job rollups", () => {
  it("listAllJobs / listJobsByAgent / getJobById report totals and measured runs", () => {
    const { project, agent, job } = agentSetup();
    // A measured run: ~120s of working time plus token usage.
    const run = createRun(job.id, agent.id)!;
    addRunUsage(run.id, { input_tokens: 1000, output_tokens: 200 });
    backdateClaim(run.id, 120);
    updateRunStatus(run.id, "done");
    // A prerun-gated skip IS claimed before the gate runs, so a few seconds of
    // gate time accrue as duration before the runner PUTs 'skipped'. That time
    // belongs in the true total but must stay out of the measured_* averages,
    // or a mostly-skipping job's avg collapses to gate time.
    const skipped = createRun(job.id, agent.id)!;
    backdateClaim(skipped.id, 3);
    updateRunStatus(skipped.id, "skipped");

    for (const rollup of [
      (listAllJobs(project.id) as JobRollup[]).find((j) => j.id === job.id)!,
      (listJobsByAgent(agent.id) as JobRollup[]).find((j) => j.id === job.id)!,
      getJobById(job.id) as JobRollup,
    ]) {
      // True total includes the skip's gate time (~120s run + ~3s skip)...
      expect(rollup.total_duration_seconds).toBeGreaterThanOrEqual(121);
      expect(rollup.total_duration_seconds).toBeLessThanOrEqual(135);
      // ...but the average inputs exclude it entirely.
      expect(rollup.measured_duration_seconds).toBeGreaterThanOrEqual(118);
      expect(rollup.measured_duration_seconds).toBeLessThanOrEqual(130);
      expect(rollup.total_tokens).toBe(1200);
      expect(rollup.measured_runs).toBe(1);
    }
  });

  it("a job with no runs reports zeros, not NULL", () => {
    const { project } = agentSetup();
    const rollup = (listAllJobs(project.id) as JobRollup[])[0];
    expect(rollup.total_duration_seconds).toBe(0);
    expect(rollup.total_tokens).toBe(0);
    expect(rollup.measured_duration_seconds).toBe(0);
    expect(rollup.measured_runs).toBe(0);
  });
});
