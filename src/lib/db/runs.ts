import { v4 as uuid } from "uuid";
import { defaultRunTitle } from "../run-title";
import { DEFAULT_RUNTIME, type Gate, isRuntime } from "../runtimes";
import { slugify } from "../slug";
import { getAgentWorkspace } from "./agents";
import { deleteRunAttachmentsDir, listAttachmentsByRun } from "./attachments";
import { getComposedDocsForJob } from "./docs";
import { getDecryptedEnvVarsForJob } from "./env-vars";
import { advanceJobSchedule } from "./jobs";
import { getDb } from "./schema";
import { getComposedTablesForJob } from "./tables";

/**
 * Shape a gate's stored `(runtime, script)` columns into the run payload's gate
 * object, or `null` when the job has no script for that gate. An unrecognized
 * stored runtime falls back to {@link DEFAULT_RUNTIME} rather than shipping a
 * value the runner can't execute.
 */
function gatePayload(runtime: string | null, content: string | null): Gate | null {
  if (!content) return null;
  return { runtime: isRuntime(runtime) ? runtime : DEFAULT_RUNTIME, content };
}

// Creates a brand-new run already 'running'. There is no prior status to
// transition from, so this INSERT is a deliberate bypass of the
// updateRunStatus transition guard — the guard governs transitions, not births.
export function createRun(jobId: string, agentId: string | null) {
  const db = getDb();
  const id = uuid();
  // Resolve org_id/project_id (denormalized; project_id is NULL for org-level
  // workflow jobs) and a placeholder title from the job.
  const job = db.prepare(`SELECT name, org_id, project_id FROM jobs WHERE id = ?`).get(jobId) as
    | { name: string; org_id: string; project_id: string | null }
    | undefined;
  if (!job) return null;
  const title = defaultRunTitle(job.name, Math.floor(Date.now() / 1000));
  db.prepare(`
    INSERT INTO runs (id, org_id, project_id, job_id, agent_id, status, claimed_at, title)
    VALUES (?, ?, ?, ?, ?, 'running', unixepoch(), ?)
  `).run(id, job.org_id, job.project_id, jobId, agentId || null, title);
  return getRunById(id);
}

export function getRunById(id: string) {
  const db = getDb();
  const run = db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.agent_id, j.prerun_script as job_prerun_script,
           j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.id = ?
  `)
    .get(id) as any;
  return run || null;
}

export function getRunWithActivity(id: string) {
  const run = getRunById(id);
  if (!run) return null;
  const activity = listRunActivity(id);
  return { ...run, activity };
}

/**
 * Legal run status transitions (current → set of allowed next statuses).
 * This is the documented lifecycle made mechanical: a small lookup, enforced
 * at the single chokepoint (updateRunStatus) so every caller — agent, user,
 * runner — inherits it. It is NOT a state-machine engine; it is a constant.
 *
 *   scheduled → running                                     (poll claims it)
 *   running   → waiting | done | failed | skipped | killed  (runner reports outcome)
 *   waiting   → pending                                      (human responds, activity route)
 *   pending   → running                                      (agent/runner claims, poll guard)
 *   failed/skipped/killed → pending                          (retry route, resume)
 *   done      → pending                                      (human resumes a finished run via comment)
 *   done      → failed                                       (#29 postrun override)
 *
 * Idempotent self-transitions (e.g. running → running) are always allowed as
 * no-ops: the runner re-reads status and must not error if it hasn't changed.
 */
const LEGAL_RUN_TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ["running"],
  running: ["waiting", "done", "failed", "skipped", "killed"],
  waiting: ["pending"],
  pending: ["running"],
  failed: ["pending"],
  skipped: ["pending"],
  killed: ["pending"],
  // done → pending: a finished run can be resumed by a human comment (activity
  // route). done → failed: reserved for the postrun gate (#29) overriding a
  // self-reported success that failed verification.
  done: ["pending", "failed"],
};

/**
 * Thrown when a caller asks for a run status transition that isn't in the
 * documented lifecycle (LEGAL_RUN_TRANSITIONS). The status PUT route catches
 * this and returns HTTP 409. `from`/`to` are exposed so callers can build a
 * precise message without re-parsing.
 */
export class IllegalRunStatusTransition extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal run status transition: ${from} → ${to}`);
    this.name = "IllegalRunStatusTransition";
  }
}

export function updateRunStatus(id: string, status: string) {
  const db = getDb();

  // Enforce the documented lifecycle at the chokepoint. Self-transitions are
  // no-ops (the runner re-checks status). createRun (INSERT 'running') and
  // requeueWorkflowRun (direct multi-column reset to 'scheduled') are
  // deliberate, documented bypasses — see their comments.
  const current = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(id) as
    | { status: string }
    | undefined;
  if (current) {
    if (current.status === status) return getRunById(id); // idempotent no-op
    const allowed = LEGAL_RUN_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new IllegalRunStatusTransition(current.status, status);
    }
  }

  const completedAt =
    status === "done" || status === "failed" || status === "skipped" || status === "killed"
      ? ", completed_at = unixepoch()"
      : ", completed_at = NULL";
  // When a run transitions out of 'running' (to any status), clear any pending
  // kill request so it can't linger and affect a subsequent run.
  const clearKill = status !== "running" ? ", kill_requested_at = NULL" : "";
  // Entering 'running' (e.g. pending -> running via the status route) starts a
  // fresh running attempt, so stamp claimed_at — the timeout hard cap measures
  // from here. Self-transitions (running -> running) already returned above as
  // no-ops, so this never resets the clock on a re-reported status.
  const enterRunning = status === "running" ? ", claimed_at = unixepoch()" : "";
  db.prepare(
    `UPDATE runs SET status = ?, updated_at = unixepoch()${completedAt}${clearKill}${enterRunning} WHERE id = ?`,
  ).run(status, id);

  // Advance the job's next_run_at when a run completes.
  // 'killed' is terminal for this run but does NOT advance the job's schedule —
  // the user stopped it intentionally and may resume it via a comment.
  if (status === "done" || status === "failed" || status === "skipped") {
    const run = getRunById(id);
    if (run?.job_id) advanceJobSchedule(run.job_id);
  }

  return getRunById(id);
}

/**
 * Requeue a workflow run for a fresh attempt. Workflow runs have no agent to
 * resume a 'pending' run, so retries go back to 'scheduled' with
 * scheduled_for = now — the next workflow runner poll claims it.
 *
 * Deliberate bypass of updateRunStatus's transition guard: this is a
 * multi-column reset (status + scheduled_for + completed_at + kill_requested_at)
 * the single-column guard can't express, and the terminal → scheduled edge
 * exists only here. Routing it through the guard would mean adding a
 * terminal → scheduled edge AND still doing the column resets separately, so we
 * keep it as one documented write.
 */
export function requeueWorkflowRun(id: string) {
  const db = getDb();
  // claimed_at = NULL: a scheduled run has not been claimed — the next runner
  // poll stamps a fresh claimed_at, which the timeout hard cap measures from.
  db.prepare(`
    UPDATE runs SET status = 'scheduled', scheduled_for = unixepoch(),
      claimed_at = NULL, completed_at = NULL, kill_requested_at = NULL, updated_at = unixepoch()
    WHERE id = ?
  `).run(id);
  return getRunById(id);
}

/**
 * Mark a run for kill. The runner picks this up on its next kill-check and
 * SIGTERMs the CLI child. Returns true if the kill was recorded, false if the
 * run isn't in a killable state.
 */
export function requestKillRun(id: string): boolean {
  const db = getDb();
  const run = getRunById(id);
  if (!run) return false;
  if (run.status !== "running") return false;
  if (run.kill_requested_at) return true; // already requested — idempotent
  db.prepare(
    `UPDATE runs SET kill_requested_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
  return true;
}

export function setRunTitle(id: string, title: string) {
  const db = getDb();
  const result = db
    .prepare(`UPDATE runs SET title = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(title, id);
  if (result.changes === 0) return null;
  return getRunById(id);
}

export function updateRunSessionId(id: string, sessionId: string, cwd?: string) {
  const db = getDb();
  if (cwd) {
    db.prepare(
      `UPDATE runs SET session_id = ?, session_cwd = ?, updated_at = unixepoch() WHERE id = ?`,
    ).run(sessionId, cwd, id);
  } else {
    db.prepare(`UPDATE runs SET session_id = ?, updated_at = unixepoch() WHERE id = ?`).run(
      sessionId,
      id,
    );
  }
}

export function isKillRequested(id: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT kill_requested_at FROM runs WHERE id = ?`).get(id) as any;
  return !!row?.kill_requested_at;
}

export function deleteRun(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
  deleteRunAttachmentsDir(id);
}

export function listRunsByJob(
  jobId: string,
  limit = 10,
  opts: { includeSkipped?: boolean; offset?: number } = {},
) {
  const db = getDb();
  const skipFilter = opts.includeSkipped ? "" : "AND r.status != 'skipped'";
  const offset = Math.max(0, opts.offset ?? 0);
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script,
           j.workflow_script as job_workflow_script,
           a.name as agent_name, a.color as agent_color, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.job_id = ? ${skipFilter}
    ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.created_at DESC
    LIMIT ? OFFSET ?
  `)
    .all(jobId, limit, offset);
}

export function listRunsByAgent(
  agentId: string,
  limit = 10,
  opts: { includeSkipped?: boolean; offset?: number } = {},
) {
  const db = getDb();
  const skipFilter = opts.includeSkipped ? "" : "AND r.status != 'skipped'";
  const offset = Math.max(0, opts.offset ?? 0);
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script,
           j.workflow_script as job_workflow_script,
           a.name as agent_name, a.color as agent_color, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.agent_id = ? ${skipFilter}
    ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.created_at DESC
    LIMIT ? OFFSET ?
  `)
    .all(agentId, limit, offset);
}

// Run list queries are MANDATORILY scoped to an org via the run's denormalized
// org_id. The optional projectId narrows further within the org but still
// includes org-level runs (project_id NULL) — dual-tier display, same
// semantics as listDocs.
export function listScheduledRuns(orgId: string, projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND (r.project_id = ? OR r.project_id IS NULL)` : "";
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'scheduled' AND r.org_id = ? ${projectFilter}
    ORDER BY r.scheduled_for ASC
  `)
    .all(...(projectId ? [orgId, projectId] : [orgId]));
}

export function listRunningRuns(orgId: string, projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND (r.project_id = ? OR r.project_id IS NULL)` : "";
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'running' AND r.org_id = ? ${projectFilter}
    ORDER BY r.updated_at DESC
  `)
    .all(...(projectId ? [orgId, projectId] : [orgId]));
}

export function listWaitingRuns(orgId: string, projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND (r.project_id = ? OR r.project_id IS NULL)` : "";
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('waiting', 'pending') AND r.org_id = ? ${projectFilter}
    ORDER BY r.updated_at ASC
  `)
    .all(...(projectId ? [orgId, projectId] : [orgId]));
}

export function listRecentRuns(orgId: string, limit = 10, projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND (r.project_id = ? OR r.project_id IS NULL)` : "";
  return db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('done', 'failed', 'killed') AND r.org_id = ? ${projectFilter}
    ORDER BY r.completed_at DESC LIMIT ?
  `)
    .all(...(projectId ? [orgId, projectId, limit] : [orgId, limit]));
}

const ALL_STATUSES = [
  "scheduled",
  "running",
  "waiting",
  "pending",
  "done",
  "failed",
  "killed",
  "skipped",
] as const;
type RunStatus = (typeof ALL_STATUSES)[number];

export type RunsHistoryFilters = {
  statuses?: RunStatus[]; // omit/empty → all except 'skipped' (use includeSkipped to opt in)
  includeSkipped?: boolean; // only meaningful if statuses is omitted
  agentId?: string;
  jobId?: string;
  projectId?: string;
  from?: number; // unix seconds (inclusive)
  to?: number; // unix seconds (inclusive)
  sort?: "newest" | "oldest";
};

export function listRunsHistory(
  orgId: string,
  filters: RunsHistoryFilters = {},
  limit = 25,
  offset = 0,
) {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];

  // MANDATORY org scope via the run's denormalized org_id.
  where.push(`r.org_id = ?`);
  params.push(orgId);

  // Status filter: validate against allowed set; default excludes 'skipped'
  let statuses =
    filters.statuses?.filter((s): s is RunStatus =>
      (ALL_STATUSES as readonly string[]).includes(s),
    ) ?? [];
  if (statuses.length === 0) {
    statuses = ALL_STATUSES.filter((s) => filters.includeSkipped || s !== "skipped");
  }
  where.push(`r.status IN (${statuses.map(() => "?").join(",")})`);
  params.push(...statuses);

  if (filters.agentId) {
    where.push(`r.agent_id = ?`);
    params.push(filters.agentId);
  }
  if (filters.jobId) {
    where.push(`r.job_id = ?`);
    params.push(filters.jobId);
  }
  if (filters.projectId) {
    // Project filter still includes org-level runs (dual-tier display).
    where.push(`(r.project_id = ? OR r.project_id IS NULL)`);
    params.push(filters.projectId);
  }
  // Time window matches the column we sort on so the filter feels predictable.
  if (filters.from != null) {
    where.push(`COALESCE(r.completed_at, r.created_at) >= ?`);
    params.push(filters.from);
  }
  if (filters.to != null) {
    where.push(`COALESCE(r.completed_at, r.created_at) <= ?`);
    params.push(filters.to);
  }

  const order = filters.sort === "oldest" ? "ASC" : "DESC";
  const safeLimit = Math.min(Math.max(1, limit | 0), 200);
  const safeOffset = Math.max(0, offset | 0);

  const rows = db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
           j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script,
           a.name as agent_name, a.color as agent_color, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(r.completed_at, r.created_at) ${order}, r.created_at ${order}
    LIMIT ? OFFSET ?
  `)
    .all(...params, safeLimit + 1, safeOffset) as any[];

  const hasMore = rows.length > safeLimit;
  return { runs: hasMore ? rows.slice(0, safeLimit) : rows, hasMore };
}

function redactSensitiveContent(content: string): string {
  return content
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\bhbr_(?:adm_)?[A-Za-z0-9]+\b/g, "[REDACTED_HARBOUR_KEY]");
}

// Activity log

export function addRunActivity(
  runId: string,
  authorType: string,
  authorId: string | null,
  authorName: string,
  content: string,
) {
  const db = getDb();
  const id = uuid();
  const safeContent = redactSensitiveContent(content);
  db.prepare(`
    INSERT INTO run_activity (id, run_id, author_type, author_id, author_name, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId, authorType, authorId, authorName, safeContent);
  db.prepare(`UPDATE runs SET updated_at = unixepoch() WHERE id = ?`).run(runId);
  return {
    id,
    run_id: runId,
    author_type: authorType,
    author_id: authorId,
    author_name: authorName,
    content: safeContent,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export type RunActivityEntry = {
  id: string;
  run_id: string;
  author_type: "agent" | "user" | "system" | "workflow";
  author_id: string | null;
  author_name: string | null;
  content: string;
  created_at: number;
};

export function listRunActivity(runId: string): RunActivityEntry[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM run_activity WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as RunActivityEntry[];
}

// Run output (streaming events from CLI agents)

export type RunOutputEvent = {
  id?: number;
  run_id: string;
  event_type: string;
  content: string | null;
  tool_name: string | null;
  created_at?: number;
};

export function addRunOutput(
  runId: string,
  events: Omit<RunOutputEvent, "run_id" | "id" | "created_at">[],
) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO run_output (run_id, event_type, content, tool_name)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction((evts: typeof events) => {
    for (const e of evts) {
      stmt.run(
        runId,
        e.event_type,
        e.content ? redactSensitiveContent(e.content) : null,
        e.tool_name || null,
      );
    }
  });
  insertMany(events);
  db.prepare(`UPDATE runs SET updated_at = unixepoch() WHERE id = ?`).run(runId);
}

export function listRunOutput(runId: string, afterId = 0) {
  const db = getDb();
  return db
    .prepare(`
    SELECT * FROM run_output WHERE run_id = ? AND id > ? ORDER BY id ASC
  `)
    .all(runId, afterId) as RunOutputEvent[];
}

/**
 * Fail a single timed-out run. The UPDATE's `AND status = 'running'` clause is
 * the concurrency guard: two reapers can both SELECT the same stale candidate
 * before either fails it, but only the one whose UPDATE actually flips the row
 * (changes === 1) inserts the timeout activity entry — exactly one timeout
 * message per timed-out run. Wrapped in a transaction so the status flip and
 * its activity row land together.
 */
export function failTimedOutRun(runId: string, timeoutMinutes: number): boolean {
  const db = getDb();
  const fail = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE runs SET status = 'failed', completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'running'`,
      )
      .run(runId);
    if (result.changes !== 1) return false;
    db.prepare(`
      INSERT INTO run_activity (id, run_id, author_type, author_name, content, created_at)
      VALUES (?, ?, 'system', 'System', ?, unixepoch())
    `).run(uuid(), runId, `Run timed out after ${timeoutMinutes} minutes without completion.`);
    return true;
  });
  return fail();
}

// Fail runs that have exceeded their job's timeout
function failStaleRuns(agentId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Hard cap on wallclock-in-running, keyed on claimed_at (when the current
  // running attempt began), NOT updated_at — streaming output refreshes
  // updated_at, which would turn this into a sliding inactivity window that
  // never fires for a chatty-but-stuck run. claimed_at is reset on every entry
  // into 'running' (see createRun, the poll claims, and updateRunStatus), so
  // this is a true ceiling: a run cannot stay 'running' past timeout_minutes.
  const stale = db
    .prepare(`
    SELECT r.id, j.timeout_minutes FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'running'
    AND r.claimed_at + (j.timeout_minutes * 60) < ?
  `)
    .all(agentId, now) as { id: string; timeout_minutes: number }[];

  let failed = 0;
  for (const run of stale) {
    if (failTimedOutRun(run.id, run.timeout_minutes)) failed++;
  }

  return failed;
}

// Agent polling: get next run

export function getAgentNextRun(agentId: string) {
  const db = getDb();

  // 0. Fail any stale running runs that exceeded their timeout
  failStaleRuns(agentId);

  // Wrap in a transaction so run assignment is atomic
  const assignRun = db.transaction(() => {
    // 1. Agent already has a running run? Return nothing (busy)
    const running = db
      .prepare(`
      SELECT id FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1
    `)
      .get(agentId) as any;
    if (running) return null;

    // 2. Pending run? (human responded, ready for agent to resume)
    const pendingRun = db
      .prepare(`
      SELECT id FROM runs
      WHERE agent_id = ? AND status = 'pending'
      ORDER BY updated_at ASC LIMIT 1
    `)
      .get(agentId) as any;

    if (pendingRun) {
      // Guard the claim: only flip it if it is still 'pending'. If a concurrent
      // runner already claimed it, changes === 0 — back off this poll rather
      // than double-claim a run another runner is now executing.
      // Reset claimed_at: this resume starts a fresh running attempt, and the
      // timeout hard cap (failStaleRuns) measures from here — without the reset
      // a run that sat in 'pending' (human wait, retry) would be capped on the
      // very next poll. See failStaleRuns for the claimed_at contract.
      const claimed = db
        .prepare(
          `UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'pending'`,
        )
        .run(pendingRun.id);
      if (claimed.changes !== 1) return null;
      return pendingRun.id as string;
    }

    const now = Math.floor(Date.now() / 1000);

    // 3. Scheduled run ready to start? (manually triggered via dashboard)
    const scheduledRun = db
      .prepare(`
      SELECT id FROM runs
      WHERE agent_id = ? AND status = 'scheduled' AND scheduled_for <= ?
      ORDER BY scheduled_for ASC LIMIT 1
    `)
      .get(agentId, now) as any;

    if (scheduledRun) {
      // Guarded claim — see the pending branch above.
      const claimed = db
        .prepare(
          `UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'scheduled'`,
        )
        .run(scheduledRun.id);
      if (claimed.changes !== 1) return null;
      db.prepare(
        `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`,
      ).run(scheduledRun.id);
      return scheduledRun.id as string;
    }

    // 4. Any recurring job past its schedule time without an active run?
    const readyJob = db
      .prepare(`
      SELECT j.id, j.agent_id FROM jobs j
      WHERE j.kind = 'agent' AND j.agent_id = ? AND j.active = 1
      AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'pending')
      )
      ORDER BY j.next_run_at ASC LIMIT 1
    `)
      .get(agentId, now) as any;

    if (readyJob) {
      const run = createRun(readyJob.id, agentId);
      db.prepare(
        `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
      ).run(readyJob.id);
      // Advance next_run_at immediately so the job doesn't re-fire on the next poll
      advanceJobSchedule(readyJob.id);
      return run!.id as string;
    }

    return null;
  });

  const runId = assignRun();
  if (!runId) return null;
  return buildRunPayload(runId);
}

// Workflow polling: get next deterministic workflow run (no agent assigned).
// MANDATORY org scope: candidate runs/jobs are constrained to the caller's org
// via the denormalized org_id so a runner never claims another org's work.
// Org-level workflows (project_id NULL) are claimed the same way as
// project-level ones — runners are org-scoped either way.
export function getNextWorkflowRun(orgId: string) {
  const db = getDb();

  // Fail stale workflow runs (scoped to this org)
  const now = Math.floor(Date.now() / 1000);
  // Hard cap keyed on claimed_at, not updated_at — see failStaleRuns for why.
  const stale = db
    .prepare(`
    SELECT r.id, j.timeout_minutes FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE j.kind = 'workflow' AND r.agent_id IS NULL AND r.status = 'running' AND r.org_id = ?
    AND r.claimed_at + (j.timeout_minutes * 60) < ?
  `)
    .all(orgId, now) as { id: string; timeout_minutes: number }[];
  for (const run of stale) {
    failTimedOutRun(run.id, run.timeout_minutes);
  }

  const assignRun = db.transaction(() => {
    // Scheduled run ready to start? (scoped to this org)
    const scheduledRun = db
      .prepare(`
      SELECT r.id FROM runs r
      JOIN jobs j ON r.job_id = j.id
      WHERE j.kind = 'workflow' AND r.agent_id IS NULL AND r.status = 'scheduled' AND r.scheduled_for <= ?
      AND r.org_id = ?
      ORDER BY r.scheduled_for ASC LIMIT 1
    `)
      .get(now, orgId) as any;

    if (scheduledRun) {
      // Guarded claim — only if still 'scheduled', so a runner that lost the
      // race to a sibling runner in the same org backs off instead of
      // re-claiming a run that is already executing.
      const claimed = db
        .prepare(
          `UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'scheduled'`,
        )
        .run(scheduledRun.id);
      if (claimed.changes !== 1) return null;
      db.prepare(
        `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`,
      ).run(scheduledRun.id);
      return scheduledRun.id as string;
    }

    // Any recurring workflow job past its schedule time? (scoped to this org)
    const readyJob = db
      .prepare(`
      SELECT j.id FROM jobs j
      WHERE j.kind = 'workflow' AND j.agent_id IS NULL AND j.active = 1
      AND j.workflow_script IS NOT NULL
      AND j.org_id = ?
      AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'pending')
      )
      ORDER BY j.next_run_at ASC LIMIT 1
    `)
      .get(orgId, now) as any;

    if (readyJob) {
      const run = createRun(readyJob.id, null);
      db.prepare(
        `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
      ).run(readyJob.id);
      advanceJobSchedule(readyJob.id);
      return run!.id as string;
    }

    return null;
  });

  const runId = assignRun();
  if (!runId) return null;
  return buildRunPayload(runId);
}

export function peekWorkflowNext(orgId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const scheduledRun = db
    .prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE j.kind = 'workflow' AND r.agent_id IS NULL AND r.status = 'scheduled' AND r.scheduled_for <= ?
    AND r.org_id = ?
    ORDER BY r.scheduled_for ASC LIMIT 1
  `)
    .get(now, orgId) as any;

  if (scheduledRun) {
    return {
      available: true,
      type: "scheduled_run",
      run_id: scheduledRun.id,
      job_name: scheduledRun.job_name,
    };
  }

  const readyJob = db
    .prepare(`
    SELECT j.id, j.name FROM jobs j
    WHERE j.kind = 'workflow' AND j.agent_id IS NULL AND j.active = 1
    AND j.workflow_script IS NOT NULL
    AND j.org_id = ?
    AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'pending')
    )
    ORDER BY j.next_run_at ASC LIMIT 1
  `)
    .get(orgId, now) as any;

  if (readyJob) {
    return { available: true, type: "scheduled", job_id: readyJob.id, job_name: readyJob.name };
  }

  return { available: false, reason: "nothing_to_do" };
}

export function peekAgentNext(agentId: string) {
  const db = getDb();

  // Fail stale runs so peek accurately reflects availability
  failStaleRuns(agentId);

  const running = db
    .prepare(`
    SELECT id FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1
  `)
    .get(agentId) as any;
  if (running) return { available: false, reason: "busy" };

  const pendingRun = db
    .prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'pending'
    ORDER BY r.updated_at ASC LIMIT 1
  `)
    .get(agentId) as any;

  if (pendingRun) {
    return {
      available: true,
      type: "pending_resume",
      run_id: pendingRun.id,
      job_name: pendingRun.job_name,
    };
  }

  const now = Math.floor(Date.now() / 1000);

  const scheduledRun = db
    .prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'scheduled' AND r.scheduled_for <= ?
    ORDER BY r.scheduled_for ASC LIMIT 1
  `)
    .get(agentId, now) as any;

  if (scheduledRun) {
    return {
      available: true,
      type: "scheduled_run",
      run_id: scheduledRun.id,
      job_name: scheduledRun.job_name,
    };
  }

  const readyJob = db
    .prepare(`
    SELECT j.id, j.name FROM jobs j
    WHERE j.kind = 'agent' AND j.agent_id = ? AND j.active = 1
    AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
    AND NOT EXISTS (SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'pending'))
    ORDER BY j.next_run_at ASC LIMIT 1
  `)
    .get(agentId, now) as any;

  if (readyJob) {
    return { available: true, type: "scheduled", job_id: readyJob.id, job_name: readyJob.name };
  }

  return { available: false, reason: "nothing_to_do" };
}

/** Only [a-z0-9-] is a safe filesystem path segment — the slug invariant. */
const SAFE_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Relative path (under the runner's `$HARBOUR_HOME/workflows` root) where the
 * runner materializes a job's scripts before running its command. Computed
 * server-side so the runner — which may be a different machine — never derives
 * paths from untrusted data. Mirrors getAgentWorkspace's slug guards.
 *
 *   agent job:        <org-slug>/<project-slug>/<agent-slug>/<job-leaf>
 *   project workflow: <org-slug>/<project-slug>/<job-leaf>
 *   org-level workflow: <org-slug>/<job-leaf>
 *
 * job-leaf = slug(job.name) + "-" + first 8 chars of job.id — stable across
 * renames (the id never changes) and collision-free (the id suffix).
 * Returns null when the job is unknown or any segment isn't a safe slug.
 */
export function getJobScriptsDir(jobId: string): string | null {
  const db = getDb();
  const job = db
    .prepare(`
      SELECT j.id, j.name, j.agent_id,
        o.slug AS org_slug, p.slug AS project_slug, a.slug AS agent_slug
      FROM jobs j
      JOIN orgs o ON j.org_id = o.id
      LEFT JOIN projects p ON j.project_id = p.id
      LEFT JOIN agents a ON j.agent_id = a.id
      WHERE j.id = ?
    `)
    .get(jobId) as
    | {
        id: string;
        name: string;
        agent_id: string | null;
        org_slug: string;
        project_slug: string | null;
        agent_slug: string | null;
      }
    | undefined;
  if (!job) return null;

  const leaf = `${slugify(job.name)}-${job.id.slice(0, 8)}`;

  // Build the segment list per tier. An agent job nests under its agent; a
  // project workflow under its project; an org-level workflow (project_id NULL)
  // sits directly under the org. Anything else is a malformed job and yields
  // null rather than a guessed path.
  let segments: string[];
  if (job.agent_id) {
    if (!job.project_slug || !job.agent_slug) return null;
    segments = [job.org_slug, job.project_slug, job.agent_slug, leaf];
  } else if (job.project_slug) {
    segments = [job.org_slug, job.project_slug, leaf];
  } else {
    segments = [job.org_slug, leaf];
  }

  // Every segment must already be a safe filesystem slug — refuse to hand the
  // runner a path it could resolve outside its workflows root.
  if (!segments.every((s) => SAFE_SLUG_RE.test(s))) return null;
  return segments.join("/");
}

export function buildRunPayload(runId: string) {
  const db = getDb();
  const run = getRunWithActivity(runId);
  if (!run) return null;

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(run.job_id) as any;

  // Docs injected from the job's attachments (job_docs), each with its content.
  const docs = getComposedDocsForJob(run.job_id);

  // Tables injected from the job's attachments (job_tables). A table is
  // a read reference: the payload carries only id + name, keyed by logical name.
  // The agent reads rows on demand via read_rows and writes via insert_rows,
  // both targeted by id — no columns or rows are inlined here.
  const linkedTables = getComposedTablesForJob(run.job_id);
  const tables: Record<string, { id: string }> = {};
  for (const t of linkedTables) tables[t.name] = { id: t.id };

  // Env vars injected from the job's attachments (job_env_vars), decrypted.
  const env = getDecryptedEnvVarsForJob(run.job_id);

  // Run attachments (raw rows; the route serializer adds absolute URLs)
  const attachments = listAttachmentsByRun(run.id);

  // Combine job instructions with any extra trigger-time instructions
  let instructions = job.instructions || null;
  if (run.extra_instructions) {
    instructions = instructions
      ? `${instructions}\n\n---\n\nAdditional instructions for this run:\n${run.extra_instructions}`
      : run.extra_instructions;
  }

  // Prepend the title-setting preamble for agent runs. Workflow runs
  // have no LLM and can't honor it.
  if (run.agent_id) {
    const formatHint = job.title_format
      ? `Format guide: ${job.title_format}`
      : `Use a short sentence summarizing what this run is doing.`;
    const preamble =
      `Before doing anything else, set a short title for this run via the ` +
      `\`set_title\` endpoint in the \`api\` section (max 80 chars). ${formatHint}`;
    instructions = instructions ? `${preamble}\n\n---\n\n${instructions}` : preamble;
  }

  // Agent runtime config — read live so runners (local or remote) pick up
  // dashboard changes without reconnecting. The runner config is identity-only;
  // cli/model/thinking/eager all come from here. Job-level model/thinking still
  // override these agent defaults (see job.model/job.thinking above).
  const agentRow = run.agent_id
    ? (db
        .prepare(`SELECT cli, model, thinking, eager FROM agents WHERE id = ?`)
        .get(run.agent_id) as
        | { cli: string | null; model: string | null; thinking: string | null; eager: number }
        | undefined)
    : undefined;
  const agent = agentRow
    ? {
        cli: agentRow.cli || null,
        model: agentRow.model || null,
        thinking: agentRow.thinking || null,
        eager: !!agentRow.eager,
      }
    : undefined;

  const isWorkflow = job.kind === "workflow";

  // Workspace slugs for agent runs (workflow runs get no workspace key). The
  // runner nests its workspace dir as <org>/<project>/<agent> from these.
  const workspace = run.agent_id ? getAgentWorkspace(run.agent_id) : null;

  return {
    run: { id: run.id, status: run.status, title: run.title || null, activity: run.activity },
    job: {
      id: job.id,
      kind: job.kind,
      name: job.name,
      instructions,
      // Each gate is a { runtime, content } gist, or null when unset. The
      // runner materializes the body into scripts_dir and runs it with the
      // runtime's interpreter. command/workflow alias the same gate.
      prerun: gatePayload(job.prerun_runtime, job.prerun_script),
      postrun: gatePayload(job.postrun_runtime, job.postrun_script),
      postrun_gates: !!job.postrun_gates,
      command: isWorkflow ? gatePayload(job.workflow_runtime, job.workflow_script) : null,
      workflow: isWorkflow ? gatePayload(job.workflow_runtime, job.workflow_script) : null,
      model: job.model || null,
      thinking: job.thinking || null,
      title_format: job.title_format || null,
      timeout_minutes: job.timeout_minutes ?? 30,
      // Relative dir (under the runner's $HARBOUR_HOME/workflows) the gate
      // scripts are materialized into before they run.
      scripts_dir: getJobScriptsDir(job.id),
    },
    ...(agent ? { agent } : {}),
    ...(workspace ? { workspace } : {}),
    docs,
    tables,
    env,
    attachments,
  };
}
