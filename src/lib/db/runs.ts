import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { defaultRunTitle } from "../run-title";
import { DEFAULT_RUNTIME, type Gate, isRuntime } from "../runtimes";
import { slugify } from "../slug";
import { getAgentWorkspace } from "./agents";
import { deleteRunAttachmentsDir, listAttachmentsByRun } from "./attachments";
import { getComposedDocsForJob } from "./docs";
import { getDecryptedEnvVarsForJob } from "./env-vars";
import { advanceJobSchedule } from "./jobs";
import { listRunners, type RunnerCapabilities, type RunnerScope, type RunnerTier } from "./runners";
import { getDb } from "./schema";
import { getComposedTablesForJob } from "./tables";
import { hashToken } from "./tokens";

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
  // workflow jobs), the run's placement, and a placeholder title from the job.
  const job = db
    .prepare(`SELECT name, org_id, project_id, placement FROM jobs WHERE id = ?`)
    .get(jobId) as
    | { name: string; org_id: string; project_id: string | null; placement: string }
    | undefined;
  if (!job) return null;
  // Placement is denormalized onto the run so the hot claim query stays flat:
  // agent runs inherit the agent's placement, workflow runs the job's.
  const placement = resolveRunPlacement(agentId, job.placement);
  const title = defaultRunTitle(job.name, Math.floor(Date.now() / 1000));
  db.prepare(`
    INSERT INTO runs (id, org_id, project_id, job_id, agent_id, status, placement, claimed_at, title)
    VALUES (?, ?, ?, ?, ?, 'running', ?, unixepoch(), ?)
  `).run(id, job.org_id, job.project_id, jobId, agentId || null, placement, title);
  return getRunById(id);
}

/**
 * The placement to stamp on a new run. Agent runs route by their agent's
 * placement; workflow runs by the job's. Falls back to 'local' so a run is
 * always claimable by the local pool even if a source row is mid-migration.
 * Shared by createRun (recurring materialization) and triggerJobRun ("Run now").
 */
export function resolveRunPlacement(agentId: string | null, jobPlacement: string): string {
  if (!agentId) return jobPlacement || "local";
  const db = getDb();
  const agent = db.prepare(`SELECT placement FROM agents WHERE id = ?`).get(agentId) as
    | { placement: string }
    | undefined;
  return agent?.placement || "local";
}

// ── Per-run executor token (exec token) ──────────────────────────────────────
//
// Minted when a run is claimed (enters 'running'); carried in the claim payload
// and used by the runner + the CLI it spawns as the credential for that run's
// lifecycle endpoints (title/status/activity/output/kill/attachments). It keeps
// the high-value runner token off the CLI and scopes the executor credential to
// a single run. Re-minted on every claim (resume), so a prior attempt's token
// stops working the moment the run is re-claimed.

function generateExecToken(): string {
  return `hbx_${crypto.randomBytes(32).toString("hex")}`;
}

/** Mint (or rotate) a run's executor token; returns the plaintext exactly once. */
export function mintExecToken(runId: string): string {
  const db = getDb();
  const token = generateExecToken();
  db.prepare(`UPDATE runs SET exec_token_hash = ?, updated_at = unixepoch() WHERE id = ?`).run(
    hashToken(token),
    runId,
  );
  return token;
}

/**
 * Resolve a run from an executor token. Returns the run joined with the bits the
 * auth layer needs to build an executor identity (job kind, agent, org/project).
 * Dedicated query so the token hash never travels through getRunById.
 */
export function getRunByExecToken(token: string) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT r.id, r.org_id, r.project_id, r.agent_id, r.status, r.job_id,
             j.kind AS job_kind, a.name AS agent_name
      FROM runs r
      JOIN jobs j ON r.job_id = j.id
      LEFT JOIN agents a ON r.agent_id = a.id
      WHERE r.exec_token_hash = ?
    `)
    .get(hashToken(token)) as
    | {
        id: string;
        org_id: string;
        project_id: string | null;
        agent_id: string | null;
        status: string;
        job_id: string;
        job_kind: string;
        agent_name: string | null;
      }
    | undefined;
  return row || null;
}

export function getRunById(id: string) {
  const db = getDb();
  const run = db
    .prepare(`
    SELECT r.*, j.name as job_name, j.kind as job_kind, j.agent_id, j.prerun_script as job_prerun_script,
           j.workflow_script as job_workflow_script, a.name as agent_name, a.color as agent_color, a.cli as agent_cli,
           cr.name as claimed_by_name, cr.tier as claimed_by_tier
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    LEFT JOIN runners cr ON r.claimed_by = cr.id
    WHERE r.id = ?
  `)
    .get(id) as any;
  if (!run) return null;
  // exec_token_hash is the per-run executor credential's hash — never surface it
  // through the generic run reader (it rides along in SELECT r.*, and getRunById
  // feeds many viewer-role API responses). The claim path mints/returns the
  // plaintext token directly; auth resolution uses the dedicated lookup below.
  run.exec_token_hash = undefined;
  return run;
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
  // Note: the exec token is deliberately NOT cleared here — the runner's postrun
  // gate (#29) posts activity and may override done->failed AFTER finalization,
  // so the token must stay valid for that trailing window. A leaked token's blast
  // radius is bounded instead by the executor gates in the auth layer (it can't
  // resurrect a run or write docs/tables once the run is terminal).
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
 * scheduled_for = now — the next runner claim picks it up.
 *
 * Deliberate bypass of updateRunStatus's transition guard: this is a
 * multi-column reset (status + scheduled_for + completed_at + kill_requested_at
 * + exec_token_hash) the single-column guard can't express, and the
 * terminal → scheduled edge exists only here. Routing it through the guard would
 * mean adding a terminal → scheduled edge AND still doing the column resets
 * separately, so we keep it as one documented write.
 */
export function requeueWorkflowRun(id: string) {
  const db = getDb();
  // claimed_at = NULL: a scheduled run has not been claimed — the next runner
  // poll stamps a fresh claimed_at, which the timeout hard cap measures from.
  // exec_token_hash = NULL: the prior attempt's token is dead; the re-claim
  // mints a fresh one.
  db.prepare(`
    UPDATE runs SET status = 'scheduled', scheduled_for = unixepoch(),
      claimed_at = NULL, completed_at = NULL, kill_requested_at = NULL,
      exec_token_hash = NULL, updated_at = unixepoch()
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

// The shared projection for every run-list query: the run row plus the job and
// agent columns the run-list UIs read. One definition so the column set can't
// drift between lists (it previously did — half omitted agent_cli). Each list
// appends only its own WHERE / ORDER BY / LIMIT.
const RUN_LIST_SELECT = `
  SELECT r.*, j.name as job_name, j.kind as job_kind, j.active as job_active,
         j.prerun_script as job_prerun_script, j.workflow_script as job_workflow_script,
         a.name as agent_name, a.color as agent_color, a.cli as agent_cli
  FROM runs r
  JOIN jobs j ON r.job_id = j.id
  LEFT JOIN agents a ON r.agent_id = a.id`;

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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    ${RUN_LIST_SELECT}
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
    .replace(/\b(?:hbr_(?:adm_)?|hbrn_|hbx_)[A-Za-z0-9]+\b/g, "[REDACTED_HARBOUR_KEY]");
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

/**
 * Reap every run stuck in 'running' past its job's timeout. Janitorial and
 * idempotent (failTimedOutRun's guarded UPDATE makes a lost race a no-op), so
 * any claim/peek can trigger it across the whole instance. Hard cap is keyed on
 * claimed_at (when the current running attempt began), NOT updated_at — streamed
 * output refreshes updated_at, which would turn this into a sliding inactivity
 * window that never fires for a chatty-but-stuck run. claimed_at resets on every
 * entry into 'running' (createRun, the claim, updateRunStatus), so this is a
 * true ceiling: a run cannot stay 'running' past timeout_minutes.
 */
function reapStaleRuns() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stale = db
    .prepare(`
    SELECT r.id, j.timeout_minutes FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running' AND r.claimed_at + (j.timeout_minutes * 60) < ?
  `)
    .all(now) as { id: string; timeout_minutes: number }[];
  let failed = 0;
  for (const run of stale) {
    if (failTimedOutRun(run.id, run.timeout_minutes)) failed++;
  }
  return failed;
}

// ── The unified claim (Runner Protocol) ──────────────────────────────────────
//
// One org-agnostic claim path replacing the per-agent /next ladder and the
// per-org workflow poll. A runner advertises its capabilities on every claim;
// the server hands back only work that (1) is due, (2) matches the runner's
// placement labels, (3) is a kind/CLI it can run, and (4) whose lock unit
// (agent_id for agent runs, job_id for workflow runs) has nothing in flight.
//
// Atomicity: the whole select-and-claim runs in one IMMEDIATE transaction, so
// concurrent claims serialize on the single SQLite writer — the lock-unit check
// and the guarded status flip can't interleave across runners. This is the
// "claims serialize for free" guarantee; no runner ever touches the DB directly.

/** The authenticated runner facts the claim path needs (capabilities arrive per-claim). */
export type ClaimRunner = {
  id: string;
  tier: RunnerTier;
  labels: string[]; // authorized labels (remote tier); local tier serves whatever it advertises
  scope: RunnerScope;
};

const IN_FLIGHT = "('running','waiting','pending')";

/**
 * The single rule for which advertised labels a runner may actually claim:
 * a remote runner is held to advertised ∩ its authorized labels; a local
 * runner is trusted to serve anything it advertises. Both the claim path
 * (via {@link claimableLabels}) and the stalled-placement surface (via
 * {@link stalledPlacements}) route through here so the three stay in lockstep.
 */
function filterClaimableLabels(
  tier: RunnerTier,
  authorizedLabels: string[],
  advertised: string[],
): string[] {
  return tier === "remote" ? advertised.filter((l) => authorizedLabels.includes(l)) : advertised;
}

/** Placement labels this runner may actually claim right now. */
function claimableLabels(runner: ClaimRunner, capabilities: RunnerCapabilities): string[] {
  const advertised = [...new Set((capabilities.labels || []).map((l) => l.trim()).filter(Boolean))];
  return filterClaimableLabels(runner.tier, runner.labels, advertised);
}

/** Eligibility computed once from a runner + its per-claim capabilities. */
type ClaimEligibility = {
  labels: string[]; // placement labels this runner may claim right now
  clis: string[]; // de-duped usable CLIs
  canAgent: boolean; // has the agent kind AND at least one CLI
  canWorkflow: boolean; // has the workflow kind AND isn't scoped to a single agent
};

/**
 * The shared eligibility prelude for both claim and peek: resolve the runner's
 * claimable labels/CLIs and what kinds it can take. Callers branch on the result
 * to return their own "nothing matches" shape (null vs `{ available, reason }`).
 */
function claimEligibility(runner: ClaimRunner, capabilities: RunnerCapabilities): ClaimEligibility {
  const labels = claimableLabels(runner, capabilities);
  const clis = [...new Set((capabilities.clis || []).filter(Boolean))];
  // Agent work needs at least one usable CLI; a remote token scoped to a single
  // agent never claims (agentless) workflow jobs.
  const canAgent = capabilities.kinds.includes("agent") && clis.length > 0;
  const canWorkflow = capabilities.kinds.includes("workflow") && !runner.scope?.agentId;
  return { labels, clis, canAgent, canWorkflow };
}

function placeholders(arr: unknown[]): string {
  return arr.map(() => "?").join(", ");
}

/** Extra `AND <alias>.org_id/agent_id = ?` clauses for a scoped (remote) token. */
function scopeClause(scope: RunnerScope, alias: "r" | "j"): { sql: string; params: string[] } {
  const sql: string[] = [];
  const params: string[] = [];
  if (scope?.orgId) {
    sql.push(`AND ${alias}.org_id = ?`);
    params.push(scope.orgId);
  }
  if (scope?.agentId) {
    sql.push(`AND ${alias}.agent_id = ?`);
    params.push(scope.agentId);
  }
  return { sql: sql.join(" "), params };
}

// ── Candidate query builders ──────────────────────────────────────────────────
//
// Each builder returns the `FROM … LIMIT 1` body (everything AFTER the SELECT
// column list) plus its exact bind params, so claimNextRun and peekClaim share
// ONE definition of every WHERE clause and bind order — claim prepends a column
// list and follows the match with the guarded UPDATE + mintExecToken; peek
// prepends `r.id`/`j.id` + a name and only reads the match. The candidate the
// caller SELECTs is then claimed inside claim's IMMEDIATE transaction.

/** A reusable candidate query: SQL body after the SELECT list, with bind params. */
type CandidateQuery = { sql: string; params: (string | number)[] };

/** Pending agent run a human nudged back to 'pending', lock unit (agent) idle. */
function pendingResumeQuery(labels: string[], clis: string[], scope: RunnerScope): CandidateQuery {
  const rScope = scopeClause(scope, "r");
  return {
    sql: `
      FROM runs r
      JOIN jobs j ON r.job_id = j.id
      JOIN agents a ON r.agent_id = a.id
      WHERE r.status = 'pending' AND j.kind = 'agent'
        AND r.placement IN (${placeholders(labels)})
        AND a.cli IN (${placeholders(clis)})
        ${rScope.sql}
        AND NOT EXISTS (
          SELECT 1 FROM runs rr WHERE rr.agent_id = r.agent_id AND rr.status IN ('running','waiting')
        )
      ORDER BY r.updated_at ASC LIMIT 1`,
    params: [...labels, ...clis, ...rScope.params],
  };
}

/** A scheduled run (either kind) due now whose lock unit is idle. */
function scheduledRunQuery(
  now: number,
  labels: string[],
  kinds: string[],
  clis: string[],
  scope: RunnerScope,
): CandidateQuery {
  const rScope = scopeClause(scope, "r");
  return {
    sql: `
      FROM runs r
      JOIN jobs j ON r.job_id = j.id
      LEFT JOIN agents a ON r.agent_id = a.id
      WHERE r.status = 'scheduled' AND r.scheduled_for <= ?
        AND r.placement IN (${placeholders(labels)})
        AND j.kind IN (${placeholders(kinds)})
        AND (j.kind = 'workflow' OR a.cli IN (${placeholders(clis)}))
        ${rScope.sql}
        AND (
          (j.kind = 'agent' AND NOT EXISTS (
            SELECT 1 FROM runs rr WHERE rr.agent_id = r.agent_id AND rr.status IN ${IN_FLIGHT}))
          OR
          (j.kind = 'workflow' AND NOT EXISTS (
            SELECT 1 FROM runs rr WHERE rr.job_id = r.job_id AND rr.status IN ${IN_FLIGHT}))
        )
      ORDER BY r.scheduled_for ASC LIMIT 1`,
    params: [now, ...labels, ...kinds, ...clis, ...rScope.params],
  };
}

/** A due recurring agent job to materialize (lock unit = the agent). */
function recurringAgentJobQuery(
  now: number,
  labels: string[],
  clis: string[],
  scope: RunnerScope,
): CandidateQuery {
  const jScope = scopeClause(scope, "j");
  return {
    sql: `
      FROM jobs j
      JOIN agents a ON j.agent_id = a.id
      WHERE j.kind = 'agent' AND j.active = 1
        AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
        AND a.placement IN (${placeholders(labels)})
        AND a.cli IN (${placeholders(clis)})
        ${jScope.sql}
        AND NOT EXISTS (
          SELECT 1 FROM runs rr WHERE rr.agent_id = j.agent_id AND rr.status IN ${IN_FLIGHT}
          UNION ALL
          SELECT 1 FROM runs rr WHERE rr.job_id = j.id AND rr.status = 'scheduled'
        )
      ORDER BY j.next_run_at ASC LIMIT 1`,
    params: [now, ...labels, ...clis, ...jScope.params],
  };
}

/** A due recurring workflow job to materialize (lock unit = the job). */
function recurringWorkflowJobQuery(
  now: number,
  labels: string[],
  scope: RunnerScope,
): CandidateQuery {
  const jScope = scopeClause(scope, "j");
  return {
    sql: `
      FROM jobs j
      WHERE j.kind = 'workflow' AND j.agent_id IS NULL AND j.active = 1
        AND j.workflow_script IS NOT NULL
        AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
        AND j.placement IN (${placeholders(labels)})
        ${jScope.sql}
        AND NOT EXISTS (
          SELECT 1 FROM runs rr WHERE rr.job_id = j.id AND rr.status IN ('scheduled','running','waiting','pending')
        )
      ORDER BY j.next_run_at ASC LIMIT 1`,
    params: [now, ...labels, ...jScope.params],
  };
}

/**
 * Claim the next runnable unit for this runner, or null when nothing matches.
 * Returns the full kind-tagged run payload plus the freshly-minted `exec_token`
 * the runner (and the CLI it spawns) uses for this run's lifecycle endpoints.
 */
export function claimNextRun(runner: ClaimRunner, capabilities: RunnerCapabilities) {
  const db = getDb();
  reapStaleRuns();

  const { labels, clis, canAgent, canWorkflow } = claimEligibility(runner, capabilities);
  if (labels.length === 0) return null;
  if (!canAgent && !canWorkflow) return null;

  const claimUpdate = (id: string, from: "scheduled" | "pending") =>
    db
      .prepare(
        `UPDATE runs SET status = 'running', claimed_by = ?, claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = ?`,
      )
      .run(runner.id, id, from);

  let execToken = "";
  const assign = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Resume an agent run a human nudged back to 'pending'. Lock unit (the
    //    agent) must have nothing else running/waiting — the pending row itself
    //    is in flight but it's the one we're claiming.
    if (canAgent) {
      const q = pendingResumeQuery(labels, clis, runner.scope);
      const pending = db.prepare(`SELECT r.id ${q.sql}`).get(...q.params) as
        | { id: string }
        | undefined;
      if (pending && claimUpdate(pending.id, "pending").changes === 1) {
        execToken = mintExecToken(pending.id);
        return pending.id;
      }
    }

    // 2. A scheduled run (either kind) due now whose lock unit is idle.
    const kinds = [canAgent && "agent", canWorkflow && "workflow"].filter(Boolean) as string[];
    if (kinds.length > 0) {
      const q = scheduledRunQuery(now, labels, kinds, clis, runner.scope);
      const scheduled = db.prepare(`SELECT r.id, j.kind ${q.sql}`).get(...q.params) as
        | { id: string; kind: string }
        | undefined;
      if (scheduled && claimUpdate(scheduled.id, "scheduled").changes === 1) {
        db.prepare(
          `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`,
        ).run(scheduled.id);
        execToken = mintExecToken(scheduled.id);
        return scheduled.id;
      }
    }

    // 3. Materialize a due recurring agent job (lock unit = the agent).
    if (canAgent) {
      const q = recurringAgentJobQuery(now, labels, clis, runner.scope);
      const job = db.prepare(`SELECT j.id, j.agent_id ${q.sql}`).get(...q.params) as
        | { id: string; agent_id: string }
        | undefined;
      if (job) {
        const id = materializeRun(db, job.id, job.agent_id, runner.id);
        execToken = mintExecToken(id);
        return id;
      }
    }

    // 4. Materialize a due recurring workflow job (lock unit = the job).
    if (canWorkflow) {
      const q = recurringWorkflowJobQuery(now, labels, runner.scope);
      const job = db.prepare(`SELECT j.id ${q.sql}`).get(...q.params) as { id: string } | undefined;
      if (job) {
        const id = materializeRun(db, job.id, null, runner.id);
        execToken = mintExecToken(id);
        return id;
      }
    }

    return null;
  });

  const runId = assign.immediate() as string | null;
  if (!runId) return null;
  const payload = buildRunPayload(runId);
  if (!payload) return null;
  return { ...payload, exec_token: execToken };
}

/** createRun + stamp claimed_by + advance the job's schedule, in one place. */
function materializeRun(
  db: ReturnType<typeof getDb>,
  jobId: string,
  agentId: string | null,
  claimedBy?: string,
): string {
  const run = createRun(jobId, agentId);
  if (!run) throw new Error("materializeRun: job vanished");
  db.prepare(`UPDATE runs SET claimed_by = ? WHERE id = ?`).run(claimedBy ?? null, run.id);
  db.prepare(
    `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
  ).run(jobId);
  advanceJobSchedule(jobId);
  return run.id as string;
}

/**
 * Non-claiming availability check for a runner — the `?peek=true` path. Proves
 * liveness and reports whether claimable work exists, without taking it. Mirrors
 * the claim's filters but selects only (never UPDATEs).
 */
// A runner is considered live if it polled within this window (the runner polls
// ~every 60s, so 3 missed polls = disconnected). Drives the absent-runner surface.
const RUNNER_LIVE_WINDOW_S = 180;

/** In-flight (running|waiting|pending) run counts keyed by claiming runner id. */
export function runningCountsByRunner(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT claimed_by AS id, COUNT(*) AS n
      FROM runs
      WHERE claimed_by IS NOT NULL AND status IN ('running','waiting','pending')
      GROUP BY claimed_by
    `)
    .all() as { id: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = r.n;
  return out;
}

/**
 * The anti-silent-stall surface: placements with queued work (scheduled/pending
 * runs in scope) that NO live runner is serving. Mandatory per the PLAN — without
 * it, a run pinned to an absent label/capability sits forever with no signal.
 * A runner "serves" a placement when it polled recently AND last advertised that
 * label (capabilities.labels). Returns [{ placement, count }] needing a runner.
 */
export function stalledPlacements(
  orgId: string,
  projectId?: string,
): { placement: string; count: number }[] {
  const db = getDb();
  const projectFilter = projectId ? `AND (r.project_id = ? OR r.project_id IS NULL)` : "";
  const params = projectId ? [orgId, projectId] : [orgId];
  const pending = db
    .prepare(`
      SELECT r.placement AS placement, COUNT(*) AS count
      FROM runs r
      WHERE r.status IN ('scheduled','pending') AND r.org_id = ? ${projectFilter}
      GROUP BY r.placement
    `)
    .all(...params) as { placement: string; count: number }[];
  if (pending.length === 0) return [];

  // Labels a live runner could ACTUALLY claim for this org — mirror the claim
  // path's eligibility, not just raw advertised labels, or we'd hide real stalls:
  //   - a remote runner only serves advertised ∩ its authorized labels;
  //   - a runner scoped to another org can't serve this org's work at all.
  // (Using raw advertised labels would let an over-advertising or cross-org
  // runner suppress the banner while the claim endpoint refuses the work.)
  const nowS = Math.floor(Date.now() / 1000);
  const served = new Set<string>();
  for (const runner of listRunners()) {
    if (!runner.last_polled_at || nowS - runner.last_polled_at > RUNNER_LIVE_WINDOW_S) continue;
    if (runner.scope?.orgId && runner.scope.orgId !== orgId) continue;
    const advertised = runner.capabilities?.labels ?? [];
    for (const label of filterClaimableLabels(runner.tier, runner.labels, advertised)) {
      served.add(label);
    }
  }
  return pending.filter((p) => !served.has(p.placement));
}

export function peekClaim(runner: ClaimRunner, capabilities: RunnerCapabilities) {
  const db = getDb();
  reapStaleRuns();

  const { labels, clis, canAgent, canWorkflow } = claimEligibility(runner, capabilities);
  if (labels.length === 0) return { available: false, reason: "no_matching_placement" };
  if (!canAgent && !canWorkflow) return { available: false, reason: "no_matching_capability" };

  const now = Math.floor(Date.now() / 1000);

  if (canAgent) {
    const q = pendingResumeQuery(labels, clis, runner.scope);
    const pending = db.prepare(`SELECT r.id, j.name AS job_name ${q.sql}`).get(...q.params) as
      | { id: string; job_name: string }
      | undefined;
    if (pending)
      return {
        available: true,
        type: "pending_resume",
        run_id: pending.id,
        job_name: pending.job_name,
      };
  }

  const kinds = [canAgent && "agent", canWorkflow && "workflow"].filter(Boolean) as string[];
  const scheduledQ = scheduledRunQuery(now, labels, kinds, clis, runner.scope);
  const scheduled = db
    .prepare(`SELECT r.id, j.name AS job_name ${scheduledQ.sql}`)
    .get(...scheduledQ.params) as { id: string; job_name: string } | undefined;
  if (scheduled)
    return {
      available: true,
      type: "scheduled_run",
      run_id: scheduled.id,
      job_name: scheduled.job_name,
    };

  if (canAgent) {
    const q = recurringAgentJobQuery(now, labels, clis, runner.scope);
    const job = db.prepare(`SELECT j.id, j.name ${q.sql}`).get(...q.params) as
      | { id: string; name: string }
      | undefined;
    if (job) return { available: true, type: "scheduled", job_id: job.id, job_name: job.name };
  }

  if (canWorkflow) {
    const q = recurringWorkflowJobQuery(now, labels, runner.scope);
    const job = db.prepare(`SELECT j.id, j.name ${q.sql}`).get(...q.params) as
      | { id: string; name: string }
      | undefined;
    if (job) return { available: true, type: "scheduled", job_id: job.id, job_name: job.name };
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
