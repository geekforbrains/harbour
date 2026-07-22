import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createJob,
  createProject,
  createWorkflow,
  getRunByExecToken,
  getRunById,
  listRunningRuns,
  listRunsByAgent,
  listRunsByJob,
  listRunsHistory,
  triggerJobRun,
  updateRunStatus,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { ALL_CAPS, claim, localRunner, peek, WORKFLOW_CAPS } from "./support/claim";

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
const NOW = () => Math.floor(Date.now() / 1000);

/** project → agent (with a CLI so it's claimable) → recurring agent job. */
function agentJob(opts: { cli?: string; placement?: string; schedule?: string } = {}) {
  const project = createProject("Site")!;
  const agent = createAgent(project.id, "Worker", undefined, {
    cli: opts.cli ?? "claude",
    placement: opts.placement,
  });
  const job = createJob(project.id, agent.id, {
    name: "Daily",
    schedule: opts.schedule ?? '{"every":60}',
  })!;
  return { project, agent, job };
}

function workflowJob(opts: { placement?: string } = {}) {
  const project = createProject("Site")!;
  const wf = createWorkflow(project.id, {
    name: "Sync",
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo sync" },
    placement: opts.placement,
  })!;
  return { project, wf };
}

function makeJobDue(jobId: string) {
  getDb().prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`).run(HOUR_AGO(), jobId);
}

function runsForJob(jobId: string) {
  return getDb().prepare(`SELECT id, status FROM runs WHERE job_id = ?`).all(jobId) as {
    id: string;
    status: string;
  }[];
}

// ── Materialization & payload ────────────────────────────────────────────────

describe("claimNextRun: materialization & payload", () => {
  it("materializes a due recurring agent job, advances its schedule, mints an exec token", () => {
    const { agent, job } = agentJob();
    makeJobDue(job.id);

    const runner = localRunner();
    const payload = claim(runner)!;
    expect(payload).toBeTruthy();
    expect(payload.job.kind).toBe("agent");
    expect(payload.run.status).toBe("running");
    // exec token is returned and is a valid hbx_ token
    expect(payload.exec_token).toMatch(/^hbx_[0-9a-f]{64}$/);

    const runs = runsForJob(job.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("running");

    // claimed_by stamped to the claiming runner
    const row = getDb()
      .prepare(`SELECT claimed_by, agent_id, placement FROM runs WHERE id = ?`)
      .get(payload.run.id) as { claimed_by: string; agent_id: string; placement: string };
    expect(row.claimed_by).toBe(runner.id);
    expect(row.agent_id).toBe(agent.id);
    expect(row.placement).toBe("local");

    // schedule advanced past now
    const j = getDb().prepare(`SELECT next_run_at FROM jobs WHERE id = ?`).get(job.id) as {
      next_run_at: number;
    };
    expect(j.next_run_at).toBeGreaterThan(NOW());
  });

  it("materializes a due recurring workflow job (no agent)", () => {
    const { wf } = workflowJob();
    makeJobDue(wf.id);
    const payload = claim()!;
    expect(payload.job.kind).toBe("workflow");
    expect(payload.job.command).toEqual({ runtime: "bash", content: "echo sync" });
    expect(payload.exec_token).toMatch(/^hbx_/);
  });

  it("claims a triggered (scheduled) agent run", () => {
    const { job } = agentJob();
    triggerJobRun(job.id);
    const payload = claim()!;
    expect(payload.run.status).toBe("running");
    expect(runsForJob(job.id).map((r) => r.status)).toEqual(["running"]);
  });

  it("returns null when there is nothing due", () => {
    agentJob(); // not due (next_run_at is in the future)
    expect(claim()).toBeNull();
  });
});

// ── Exec token ───────────────────────────────────────────────────────────────

describe("claimNextRun: exec token", () => {
  it("resolves the run from its exec token, and getRunById never leaks the hash", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    const payload = claim()!;

    const viaToken = getRunByExecToken(payload.exec_token)!;
    expect(viaToken.id).toBe(payload.run.id);

    const run = getRunById(payload.run.id) as Record<string, unknown>;
    expect(run.exec_token_hash).toBeUndefined();
  });

  it("never leaks the hash through any run-list query", () => {
    const { agent, job } = agentJob();
    makeJobDue(job.id);
    claim(); // mints the exec token → exec_token_hash is set on the run row

    const surfaces: Record<string, unknown>[][] = [
      listRunsByJob(job.id) as Record<string, unknown>[],
      listRunsByAgent(agent.id) as Record<string, unknown>[],
      listRunningRuns() as Record<string, unknown>[],
      listRunsHistory({ statuses: ["running"] }).runs as Record<string, unknown>[],
    ];
    for (const rows of surfaces) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.exec_token_hash).toBeUndefined();
    }
  });

  it("keeps the token valid on a terminal run (for the runner's trailing postrun)", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    const payload = claim()!;
    updateRunStatus(payload.run.id, "done");
    // The token still resolves: the runner's postrun gate posts activity and may
    // override done->failed after finalization. The auth-layer executor gates
    // (no resurrect, no docs/tables writes once terminal) bound a leaked token.
    expect(getRunByExecToken(payload.exec_token)!.id).toBe(payload.run.id);
  });

  it("rotates the exec token on re-claim so a prior attempt's token stops working", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    const first = claim()!;
    // Drive the run waiting → pending, then re-claim (resume).
    updateRunStatus(first.run.id, "waiting");
    updateRunStatus(first.run.id, "pending");
    const second = claim()!;
    expect(second.run.id).toBe(first.run.id);
    expect(second.exec_token).not.toBe(first.exec_token);
    // Old token no longer resolves; new one does.
    expect(getRunByExecToken(first.exec_token)).toBeNull();
    expect(getRunByExecToken(second.exec_token)!.id).toBe(first.run.id);
  });
});

// ── Lock unit: serialize per agent / per workflow job ─────────────────────────

describe("claimNextRun: lock unit (serialize per unit)", () => {
  it("never runs two of the same agent's runs at once (across distinct jobs)", () => {
    const { project, agent } = agentJob();
    const jobA = createJob(project.id, agent.id, { name: "A", schedule: '{"every":60}' })!;
    const jobB = createJob(project.id, agent.id, { name: "B", schedule: '{"every":60}' })!;
    makeJobDue(jobA.id);
    makeJobDue(jobB.id);

    const first = claim()!;
    expect(first).toBeTruthy();
    // The agent is now busy; the other job must NOT be claimed.
    expect(claim()).toBeNull();

    // Finish the first run; now the agent is free and the second job claims.
    updateRunStatus(first.run.id, "done");
    const second = claim()!;
    expect(second).toBeTruthy();
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("never doubles up a single workflow job", () => {
    const { wf } = workflowJob();
    makeJobDue(wf.id);
    expect(claim()).toBeTruthy();
    makeJobDue(wf.id); // due again by schedule, but a run is in flight
    expect(claim()).toBeNull();
    expect(runsForJob(wf.id).length).toBe(1);
  });

  it("resumes a pending agent run", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    const first = claim()!;
    updateRunStatus(first.run.id, "waiting");
    updateRunStatus(first.run.id, "pending");
    const resumed = claim()!;
    expect(resumed.run.id).toBe(first.run.id);
    expect(resumed.run.status).toBe("running");
  });

  it("a waiting run does not hold the agent lock, but a running one does", () => {
    const { project, agent, job } = agentJob();

    // First run for the agent pauses for human input (waiting). Unlike running,
    // a waiting run has no timeout — it must not strand the agent's other work.
    makeJobDue(job.id);
    const first = claim()!;
    updateRunStatus(first.run.id, "waiting");

    // A second run is triggered for the same agent (another job). The agent is
    // idle (only waiting), so the scheduled run must be claimable.
    const jobB = createJob(project.id, agent.id, { name: "B", schedule: '{"every":60}' })!;
    triggerJobRun(jobB.id);
    const second = claim()!;
    expect(second).toBeTruthy();
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.job.name).toBe("B");

    // Now B is running — a running run DOES still serialize the agent. A third
    // due run for the same agent must not be claimed (single workspace/session).
    const jobC = createJob(project.id, agent.id, { name: "C", schedule: '{"every":60}' })!;
    triggerJobRun(jobC.id);
    expect(claim()).toBeNull();
  });
});

// ── Parallelism across distinct units, unbounded by project ───────────────────

describe("claimNextRun: parallel across distinct units / projects", () => {
  it("claims distinct agents from different projects independently", () => {
    const a = agentJob();
    makeJobDue(a.job.id);
    // A second project with its own agent + due job.
    const project2 = createProject("Other Site")!;
    const agent2 = createAgent(project2.id, "Worker2", undefined, { cli: "claude" });
    const job2 = createJob(project2.id, agent2.id, { name: "Daily", schedule: '{"every":60}' })!;
    makeJobDue(job2.id);

    const runner = localRunner();
    const first = claim(runner)!;
    const second = claim(runner)!;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    // Two different agents claimed despite being in different projects.
    const agents = new Set([first.run.id, second.run.id]);
    expect(agents.size).toBe(2);
    expect(claim(runner)).toBeNull();
  });
});

// ── Placement routing ─────────────────────────────────────────────────────────

describe("claimNextRun: placement", () => {
  it("a local runner advertising ['local'] does not claim a 'gpu'-placed run", () => {
    const { job } = agentJob({ placement: "gpu" });
    makeJobDue(job.id);
    // default local runner advertises only the 'local' label
    expect(claim(localRunner(), ALL_CAPS)).toBeNull();
  });

  it("claims a 'gpu'-placed run when the runner advertises 'gpu'", () => {
    const { job } = agentJob({ placement: "gpu" });
    makeJobDue(job.id);
    const payload = claim(localRunner(), { ...ALL_CAPS, labels: ["local", "gpu"] })!;
    expect(payload).toBeTruthy();
  });
});

// ── Capability honesty ────────────────────────────────────────────────────────

describe("claimNextRun: capabilities", () => {
  it("a workflow-only runner does not claim agent work", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    expect(claim(localRunner(), WORKFLOW_CAPS)).toBeNull();
  });

  it("does not claim an agent run whose CLI the runner doesn't advertise", () => {
    const { job } = agentJob({ cli: "codex" });
    makeJobDue(job.id);
    expect(claim(localRunner(), { ...ALL_CAPS, clis: ["claude"] })).toBeNull();
    expect(claim(localRunner(), { ...ALL_CAPS, clis: ["codex"] })).toBeTruthy();
  });

  it("an agent with no CLI configured is not claimable by a CLI runner", () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "External"); // cli = null
    const job = createJob(project.id, agent.id, { name: "Daily", schedule: '{"every":60}' })!;
    makeJobDue(job.id);
    expect(claim()).toBeNull();
  });

  it("a runner without the 'workflow' kind does not claim workflow work", () => {
    const { wf } = workflowJob();
    makeJobDue(wf.id);
    expect(
      claim(localRunner(), { kinds: ["agent"], clis: ["claude"], labels: ["local"] }),
    ).toBeNull();
  });
});

// ── Remote scope ──────────────────────────────────────────────────────────────

describe("claimNextRun: remote scope", () => {
  it("a remote runner only serves labels it is authorized for", () => {
    const { job } = agentJob({ placement: "gpu" });
    makeJobDue(job.id);
    // Authorized for 'local' only, even though it advertises 'gpu'.
    const runner = localRunner({ tier: "remote", labels: ["local"] });
    expect(claim(runner, { ...ALL_CAPS, labels: ["local", "gpu"] })).toBeNull();
    // Authorized for 'gpu' → claims.
    const ok = localRunner({ tier: "remote", labels: ["gpu"] });
    expect(claim(ok, { ...ALL_CAPS, labels: ["gpu"] })).toBeTruthy();
  });

  it("an agent-scoped remote runner only claims its own agent's work", () => {
    const a = agentJob();
    makeJobDue(a.job.id);
    const other = createAgent(a.project.id, "Other", undefined, { cli: "claude" });
    const runner = localRunner({
      tier: "remote",
      labels: ["local"],
      scope: { agentId: other.id },
    });
    expect(claim(runner)).toBeNull(); // the due job belongs to a different agent
    const scoped = localRunner({
      tier: "remote",
      labels: ["local"],
      scope: { agentId: a.agent.id },
    });
    expect(claim(scoped)).toBeTruthy();
  });

  it("an agent-scoped remote runner never claims workflow work", () => {
    const { wf } = workflowJob();
    makeJobDue(wf.id);
    const runner = localRunner({
      tier: "remote",
      labels: ["local"],
      scope: { agentId: "some-agent" },
    });
    expect(claim(runner)).toBeNull();
  });
});

// ── peekClaim ─────────────────────────────────────────────────────────────────

describe("peekClaim", () => {
  it("reports availability without claiming", () => {
    const { job } = agentJob();
    makeJobDue(job.id);
    const result = peek() as { available: boolean; type?: string };
    expect(result.available).toBe(true);
    expect(result.type).toBe("scheduled");
    // No run was materialized by peek.
    expect(runsForJob(job.id).length).toBe(0);
  });

  it("reports nothing_to_do when idle", () => {
    agentJob(); // not due
    expect(peek()).toEqual({ available: false, reason: "nothing_to_do" });
  });

  it("reports no_matching_placement when the runner serves no matching label", () => {
    const { job } = agentJob({ placement: "gpu" });
    makeJobDue(job.id);
    const result = peek(localRunner(), ALL_CAPS) as { available: boolean; reason?: string };
    expect(result.available).toBe(false);
  });
});
