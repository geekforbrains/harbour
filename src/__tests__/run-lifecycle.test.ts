import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createJob,
  createProject,
  createRun,
  createWorkflow,
  failTimedOutRun,
  getRunById,
  listRunActivity,
  requeueWorkflowRun,
  updateRunStatus,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { claim, localRunner } from "./support/claim";

// ---------------------------------------------------------------------------
// Run lifecycle — reaper race dedupe + requeue claimed_at reset
//
// 1. The stale-run reaper SELECTs candidates and then fails each one. Two
//    concurrent polls can both snapshot the same stale run before either
//    fails it; the per-run fail step must therefore be guarded so exactly ONE
//    timeout activity entry is ever recorded per timed-out run.
//
// 2. requeueWorkflowRun resets a terminal run to 'scheduled' — a state that
//    by definition has not been claimed — so claimed_at must be cleared, not
//    left over from the previous attempt.
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

const NOW = () => Math.floor(Date.now() / 1000);

function backdateClaim(runId: string, secondsAgo: number) {
  getDb()
    .prepare(`UPDATE runs SET claimed_at = ? WHERE id = ?`)
    .run(NOW() - secondsAgo, runId);
}

function timeoutActivityRows(runId: string) {
  return (listRunActivity(runId) as { author_type: string; content: string }[]).filter(
    (a) => a.author_type === "system" && /timed out/i.test(a.content),
  );
}

function agentSetup() {
  const project = createProject("Website")!;
  const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  return { project, agent, job };
}

function workflowSetup() {
  const project = createProject("Site")!;
  const wf = createWorkflow(project.id, {
    name: "Sync",
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo sync" },
  })!;
  return { project, wf };
}

// ===========================================================================
// Stale-run reaper: exactly one timeout activity row per timed-out run
// ===========================================================================

describe("stale-run reaper: timeout activity dedupe under concurrent polls", () => {
  it("a racing reaper that pre-selected the same stale candidate inserts no duplicate activity", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 40 * 60); // past the 30-min default cap

    // Both reapers snapshot the same stale candidate set (the race window:
    // SELECT happens on both polls before either fails the run).
    const candidate = { id: run.id, timeout_minutes: 30 };

    // Reaper A: the real claim path reaps stale runs first, failing this run
    // and logging the timeout.
    claim(localRunner());
    expect(getRunById(run.id)!.status).toBe("failed");
    expect(timeoutActivityRows(run.id).length).toBe(1);

    // Reaper B: completes its loop from the stale snapshot. The guarded
    // UPDATE flips zero rows, so it must NOT insert a second activity entry.
    expect(failTimedOutRun(candidate.id, candidate.timeout_minutes)).toBe(false);
    expect(getRunById(run.id)!.status).toBe("failed");
    expect(timeoutActivityRows(run.id).length).toBe(1);
  });

  it("failTimedOutRun called twice with the same candidate fails the run once", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 40 * 60);

    expect(failTimedOutRun(run.id, 30)).toBe(true);
    expect(failTimedOutRun(run.id, 30)).toBe(false);

    expect(getRunById(run.id)!.status).toBe("failed");
    expect(timeoutActivityRows(run.id).length).toBe(1);
  });

  it("does not touch a non-stale running run", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    backdateClaim(run.id, 60); // claimed 1 min ago — well within the cap

    claim(localRunner());

    expect(getRunById(run.id)!.status).toBe("running");
    expect(timeoutActivityRows(run.id).length).toBe(0);
  });

  it("workflow reaper path also dedupes against a racing snapshot", () => {
    const { wf } = workflowSetup();
    const run = createRun(wf.id, null)!;
    backdateClaim(run.id, 40 * 60);

    claim(localRunner()); // reaps the stale workflow run before claiming
    expect(getRunById(run.id)!.status).toBe("failed");
    expect(timeoutActivityRows(run.id).length).toBe(1);

    // Racing runner with a pre-reap snapshot backs off.
    expect(failTimedOutRun(run.id, 30)).toBe(false);
    expect(timeoutActivityRows(run.id).length).toBe(1);
  });
});

// ===========================================================================
// requeueWorkflowRun: claimed_at cleared, run claimable again
// ===========================================================================

describe("requeueWorkflowRun: resets claimed_at", () => {
  it("clears the stale claimed_at from the previous attempt", () => {
    const { wf } = workflowSetup();
    const run = createRun(wf.id, null)!; // born 'running', claimed_at = now
    updateRunStatus(run.id, "failed");

    const requeued = requeueWorkflowRun(run.id)!;

    expect(requeued.status).toBe("scheduled");
    expect(requeued.claimed_at).toBeNull();
  });

  it("a requeued run can be claimed normally and gets a fresh claimed_at", () => {
    const { wf } = workflowSetup();
    const run = createRun(wf.id, null)!;
    updateRunStatus(run.id, "failed");
    requeueWorkflowRun(run.id);

    const payload = claim(localRunner());
    expect(payload).toBeTruthy();
    expect(payload!.run.id).toBe(run.id);

    const claimed = getRunById(run.id)!;
    expect(claimed.status).toBe("running");
    expect(claimed.claimed_at).toBeGreaterThanOrEqual(NOW() - 5);
  });
});
