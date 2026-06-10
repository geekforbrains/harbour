import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import {
  createOrg,
  createProject,
  createAgent,
  createJob,
  createWorkflow,
  createRun,
  getRunById,
  getAgentNextRun,
  getNextWorkflowRun,
  updateRunStatus,
  listRunActivity,
} from "@/lib/db/queries";

// ---------------------------------------------------------------------------
// Run timeout — server-side hard cap (issue #15)
//
// The stale-run reaper is now a TRUE hard ceiling keyed on `claimed_at` (when
// the current running attempt began), NOT `updated_at` (which streaming output
// refreshes). `timeout_minutes` therefore means "the absolute maximum a run can
// exist in the running state", independent of how chatty the agent is. The
// runner's inactivity timer catches live hangs well before this fires.
//
// For the cap to make sense across resumes/retries, `claimed_at` must be reset
// every time a run (re)enters `running` — otherwise a run that waited hours for
// a human, or was retried days later, would be capped the instant it resumes.
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

function setTimes(runId: string, t: { claimedAt?: number; updatedAt?: number }) {
  const db = getDb();
  if (t.claimedAt !== undefined) db.prepare(`UPDATE runs SET claimed_at = ? WHERE id = ?`).run(t.claimedAt, runId);
  if (t.updatedAt !== undefined) db.prepare(`UPDATE runs SET updated_at = ? WHERE id = ?`).run(t.updatedAt, runId);
}

function claimedAtOf(runId: string): number {
  return (getDb().prepare(`SELECT claimed_at AS c FROM runs WHERE id = ?`).get(runId) as { c: number }).c;
}

function agentSetup() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Website")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  return { org, project, agent, job };
}

// ===========================================================================
// Agent path — failStaleRuns keyed on claimed_at, not updated_at
// ===========================================================================

describe("failStaleRuns (agent path): hard cap keyed on claimed_at", () => {
  it("fails a run claimed longer ago than the job timeout even if updated_at is recent", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!; // born 'running', claimed_at = now
    // Claimed 40 min ago (> the 30-min cap) but still actively streaming.
    setTimes(run.id, { claimedAt: NOW() - 40 * 60, updatedAt: NOW() - 1 });

    getAgentNextRun(agent.id); // reaps stale runs before assigning

    expect(getRunById(run.id)!.status).toBe("failed");
    const activity = listRunActivity(run.id);
    expect(
      activity.some((a: { author_type: string; content: string }) => a.author_type === "system" && /timed out/i.test(a.content)),
    ).toBe(true);
  });

  it("does NOT fail a run claimed within the timeout even if updated_at is stale", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    // Just claimed (1 min ago) but no output yet (updated 40 min ago).
    setTimes(run.id, { claimedAt: NOW() - 60, updatedAt: NOW() - 40 * 60 });

    getAgentNextRun(agent.id);

    expect(getRunById(run.id)!.status).toBe("running");
  });
});

// ===========================================================================
// Workflow path — same hard cap in getNextWorkflowRun
// ===========================================================================

describe("getNextWorkflowRun: hard cap keyed on claimed_at", () => {
  it("fails a workflow run claimed past the timeout despite recent updated_at", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const wf = createWorkflow(project.id, { name: "Sync", schedule: '{"every":60}', command: "echo sync" })!;
    const run = createRun(wf.id, null)!;
    setTimes(run.id, { claimedAt: NOW() - 40 * 60, updatedAt: NOW() - 1 });

    getNextWorkflowRun(org.id);

    expect(getRunById(run.id)!.status).toBe("failed");
  });

  it("does NOT fail a workflow run claimed within the timeout", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const wf = createWorkflow(project.id, { name: "Sync", schedule: '{"every":60}', command: "echo sync" })!;
    const run = createRun(wf.id, null)!;
    setTimes(run.id, { claimedAt: NOW() - 60, updatedAt: NOW() - 40 * 60 });

    getNextWorkflowRun(org.id);

    expect(getRunById(run.id)!.status).toBe("running");
  });
});

// ===========================================================================
// claimed_at is reset on every (re)entry into running
// ===========================================================================

describe("claimed_at resets when a run (re)enters running", () => {
  it("resets claimed_at on a pending->running re-claim so a long-waited run isn't instantly capped", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!; // running
    updateRunStatus(run.id, "waiting");
    updateRunStatus(run.id, "pending");
    // Simulate a long human wait: ancient timestamps while parked in 'pending'.
    setTimes(run.id, { claimedAt: NOW() - 9999, updatedAt: NOW() - 9999 });

    const payload = getAgentNextRun(agent.id); // claims pending -> running
    expect(payload).toBeTruthy();
    expect(getRunById(run.id)!.status).toBe("running");
    expect(claimedAtOf(run.id)).toBeGreaterThanOrEqual(NOW() - 5); // freshly stamped

    // A subsequent poll reaps stale runs again — the fresh run must survive.
    getAgentNextRun(agent.id);
    expect(getRunById(run.id)!.status).toBe("running");
  });

  it("resets claimed_at when updateRunStatus transitions a run into running", () => {
    const { agent, job } = agentSetup();
    const run = createRun(job.id, agent.id)!;
    updateRunStatus(run.id, "waiting");
    updateRunStatus(run.id, "pending");
    setTimes(run.id, { claimedAt: NOW() - 9999 });

    updateRunStatus(run.id, "running"); // status-route claim path

    expect(claimedAtOf(run.id)).toBeGreaterThanOrEqual(NOW() - 5);
  });
});
