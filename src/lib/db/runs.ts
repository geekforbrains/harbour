import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import { getDecryptedEnvVarsForJob } from "./env-vars";
import { getCredentialBrokerEnvForJob, getSecretValuesForRun } from "./credential-profiles";
import { advanceJobSchedule } from "./jobs";
import { listAttachmentsByRun, deleteRunAttachmentsDir } from "./attachments";
import { importSkillsFromFilesystem, resolveSkillsForAgent } from "./skills";
import { getToolkitLibraries, RUNTIME_SECURITY } from "../toolkit-libraries";
import { redactSecrets } from "../redaction";
import { ingestNotificationsForRun } from "./notifications";
import { defaultRunTitle } from "../run-title";

type RunRow = {
  [key: string]: unknown;
  id: string;
  job_id: string;
  agent_id: string | null;
  status: string;
  kill_requested_at?: number | null;
  extra_instructions?: string | null;
};
type RunActivityRow = {
  id: string;
  run_id: string;
  author_type: string;
  author_id?: string | null;
  author_name: string;
  content: string;
  created_at: number;
};
type RunWithActivity = RunRow & { activity: RunActivityRow[] };
type IdRow = { id: string };
type OneOffRow = { one_off: number };
type KillRequestedRow = { kill_requested_at: number | null };
type ReadyJobRow = { id: string; agent_id: string | null };
type NamedRunRow = { id: string; job_name: string | null };
type NamedJobRow = { id: string; name: string };
type JobPayloadRow = {
  id: string;
  name: string;
  instructions: string | null;
  workflow_command: string | null;
  workflow_only: number;
  model: string | null;
  thinking: string | null;
  credential_profile_id: string | null;
  title_format: string | null;
  timeout_minutes: number | null;
};
type AgentPayloadRow = {
  eager: number;
  composio_cli_enabled: number;
  composio_mcp_enabled: number;
  composio_toolkits: string | null;
  composio_tools: string | null;
  cli: string | null;
  scope_type: string | null;
  workspace_id: string | null;
  project_id: string | null;
};
type DocPayloadRow = { id: string; title: string; content: string | null };
type TableDataRow = Record<string, unknown>;

const RUN_HISTORY_STATUSES = new Set(["scheduled", "running", "waiting", "pending", "done", "failed", "skipped", "killed"]);

export type RunsHistoryFilters = {
  statuses?: string[];
  includeSkipped?: boolean;
  agentId?: string;
  jobId?: string;
  projectId?: string;
  from?: number;
  to?: number;
  sort?: "newest" | "oldest";
};

export function createRun(jobId: string, agentId: string | null) {
  const db = getDb();
  const id = uuid();
  const job = db.prepare(`SELECT name FROM jobs WHERE id = ?`).get(jobId) as NamedJobRow | undefined;
  const title = job ? defaultRunTitle(job.name, Math.floor(Date.now() / 1000)) : null;
  db.prepare(`
    INSERT INTO runs (id, job_id, agent_id, status, claimed_at, title)
    VALUES (?, ?, ?, 'running', unixepoch(), ?)
  `).run(id, jobId, agentId || null, title);
  return getRunById(id);
}

export function getRunById(id: string): RunRow | null {
  const db = getDb();
  const run = db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.workflow_only as job_workflow_only, j.agent_id, a.name as agent_name, a.type as agent_type, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
      LEFT JOIN agents a ON r.agent_id = a.id
      WHERE r.id = ?
  `).get(id) as RunRow | undefined;
  return run || null;
}

export function getRunWithActivity(id: string): RunWithActivity | null {
  const run = getRunById(id);
  if (!run) return null;
  const activity = listRunActivity(id);
  return { ...run, activity };
}

export function updateRunStatus(id: string, status: string) {
  const db = getDb();
  const completedAt = (status === "done" || status === "failed" || status === "skipped" || status === "killed")
    ? ", completed_at = unixepoch()"
    : ", completed_at = NULL";
  // When a run transitions out of 'running' (to any status), clear any pending
  // kill request so it can't linger and affect a subsequent run that somehow
  // reuses the id.
  const clearKill = status !== "running" ? ", kill_requested_at = NULL" : "";
  db.prepare(`UPDATE runs SET status = ?, updated_at = unixepoch()${completedAt}${clearKill} WHERE id = ?`).run(status, id);

  // Advance the job's next_run_at when a run completes.
  // 'killed' is terminal for this run but does NOT advance the job's schedule —
  // the user stopped it intentionally and may resume it via a comment.
  if (status === "done" || status === "failed" || status === "skipped") {
    const run = getRunById(id);
    if (run?.job_id) {
      // Deactivate one-off jobs; advance schedule for recurring ones
      const job = db.prepare(`SELECT one_off FROM jobs WHERE id = ?`).get(run.job_id) as OneOffRow | undefined;
      if (job?.one_off) {
        db.prepare(`UPDATE jobs SET active = 0, next_run_at = NULL, updated_at = unixepoch() WHERE id = ?`).run(run.job_id);
      } else {
        advanceJobSchedule(run.job_id);
      }
    }
    ingestNotificationsForRun(id, status);
  }

  return getRunById(id);
}

/**
 * Mark a run for kill. The runner picks this up on its next kill-check and
 * SIGTERMs the CLI child. Returns true if the kill was recorded, false if the
 * run isn't in a killable state (not running, already killed, etc).
 */
export function requestKillRun(id: string): boolean {
  const db = getDb();
  const run = getRunById(id);
  if (!run) return false;
  if (run.status !== "running") return false;
  if (run.kill_requested_at) return true; // already requested — idempotent
  db.prepare(`UPDATE runs SET kill_requested_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(id);
  return true;
}

export function setRunTitle(id: string, title: string) {
  const db = getDb();
  const result = db.prepare(
    `UPDATE runs SET title = ?, updated_at = unixepoch() WHERE id = ?`
  ).run(title, id);
  if (result.changes === 0) return null;
  return getRunById(id);
}

export function updateRunSessionId(id: string, sessionId: string, cwd?: string) {
  const db = getDb();
  if (cwd) {
    db.prepare(`UPDATE runs SET session_id = ?, session_cwd = ?, updated_at = unixepoch() WHERE id = ?`).run(sessionId, cwd, id);
  } else {
    db.prepare(`UPDATE runs SET session_id = ?, updated_at = unixepoch() WHERE id = ?`).run(sessionId, id);
  }
}

export function isKillRequested(id: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT kill_requested_at FROM runs WHERE id = ?`).get(id) as KillRequestedRow | undefined;
  return !!row?.kill_requested_at;
}

export function deleteRun(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
  deleteRunAttachmentsDir(id);
}

export function listRunsByJob(jobId: string, limit = 50, opts: { includeSkipped?: boolean; offset?: number } = {}) {
  const db = getDb();
  const skipFilter = opts.includeSkipped ? "" : "AND r.status != 'skipped'";
  const offset = Math.max(0, opts.offset ?? 0);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.active as job_active,
           j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only,
           a.name as agent_name, a.type as agent_type, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.job_id = ? ${skipFilter}
    ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(jobId, limit, offset);
}

export function listRunsByAgent(agentId: string, limit = 50, opts: { includeSkipped?: boolean; offset?: number } = {}) {
  const db = getDb();
  const skipFilter = opts.includeSkipped ? "" : "AND r.status != 'skipped'";
  const offset = Math.max(0, opts.offset ?? 0);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.active as job_active,
           j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only,
           a.name as agent_name, a.type as agent_type, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.agent_id = ? ${skipFilter}
    ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, limit, offset);
}

function runScopeFilter(projectId?: string, workspaceId?: string) {
  if (projectId) {
    return {
      sql: `AND r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)`,
      values: [projectId],
    };
  }
  if (workspaceId) {
    return {
      sql: `AND (
        r.agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)
        OR r.job_id IN (
          SELECT pj.job_id
          FROM project_jobs pj
          JOIN projects p ON p.id = pj.project_id
          WHERE p.workspace_id = ?
        )
      )`,
      values: [workspaceId, workspaceId],
    };
  }
  return { sql: "", values: [] };
}

export function listScheduledRuns(projectId?: string, workspaceId?: string) {
  const db = getDb();
  const scope = runScopeFilter(projectId, workspaceId);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'scheduled' ${scope.sql}
    ORDER BY r.scheduled_for ASC
  `).all(...scope.values);
}

export function listRunningRuns(projectId?: string, workspaceId?: string) {
  const db = getDb();
  const scope = runScopeFilter(projectId, workspaceId);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'running' ${scope.sql}
    ORDER BY r.updated_at DESC
  `).all(...scope.values);
}

export function listWaitingRuns(projectId?: string, workspaceId?: string) {
  const db = getDb();
  const scope = runScopeFilter(projectId, workspaceId);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('waiting', 'pending') ${scope.sql}
    ORDER BY r.updated_at ASC
  `).all(...scope.values);
}

export function listRecentRuns(limit = 10, projectId?: string, workspaceId?: string) {
  const db = getDb();
  const scope = runScopeFilter(projectId, workspaceId);
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('done', 'failed', 'killed') ${scope.sql}
    ORDER BY r.completed_at DESC LIMIT ?
  `).all(...scope.values, limit);
}

export function listRunsHistory(filters: RunsHistoryFilters = {}, limit = 25, offset = 0) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
  const safeOffset = Math.max(Math.floor(offset) || 0, 0);
  const clauses: string[] = [];
  const values: unknown[] = [];
  const statuses = (filters.statuses?.length
    ? filters.statuses
    : ["running", "waiting", "pending", "done", "failed", "killed"]
  ).filter(status => RUN_HISTORY_STATUSES.has(status));

  if (statuses.length) {
    clauses.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  } else if (!filters.includeSkipped) {
    clauses.push(`r.status != 'skipped'`);
  }
  if (!filters.includeSkipped && !statuses.includes("skipped")) {
    clauses.push(`r.status != 'skipped'`);
  }
  if (filters.agentId) {
    clauses.push(`r.agent_id = ?`);
    values.push(filters.agentId);
  }
  if (filters.jobId) {
    clauses.push(`r.job_id = ?`);
    values.push(filters.jobId);
  }
  if (filters.projectId) {
    clauses.push(`r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)`);
    values.push(filters.projectId);
  }
  if (Number.isFinite(filters.from)) {
    clauses.push(`COALESCE(r.completed_at, r.updated_at, r.created_at) >= ?`);
    values.push(filters.from);
  }
  if (Number.isFinite(filters.to)) {
    clauses.push(`COALESCE(r.completed_at, r.updated_at, r.created_at) <= ?`);
    values.push(filters.to);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const direction = filters.sort === "oldest" ? "ASC" : "DESC";
  const rows = db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    ${where}
    ORDER BY COALESCE(r.completed_at, r.updated_at, r.created_at) ${direction}, r.created_at ${direction}
    LIMIT ? OFFSET ?
  `).all(...values, safeLimit + 1, safeOffset);

  return {
    runs: rows.slice(0, safeLimit),
    hasMore: rows.length > safeLimit,
  };
}

// Activity log

export function addRunActivity(runId: string, authorType: string, authorId: string | null, authorName: string, content: string) {
  const db = getDb();
  const id = uuid();
  const safeContent = redactSecrets(content, getSecretValuesForRun(runId));
  db.prepare(`
    INSERT INTO run_activity (id, run_id, author_type, author_id, author_name, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId, authorType, authorId, authorName, safeContent);
  db.prepare(`UPDATE runs SET updated_at = unixepoch() WHERE id = ?`).run(runId);
  return { id, run_id: runId, author_type: authorType, author_id: authorId, author_name: authorName, content: safeContent, created_at: Math.floor(Date.now() / 1000) };
}

export function listRunActivity(runId: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM run_activity WHERE run_id = ? ORDER BY created_at ASC`).all(runId) as RunActivityRow[];
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

export function addRunOutput(runId: string, events: Omit<RunOutputEvent, "run_id" | "id" | "created_at">[]) {
  const db = getDb();
  const secretValues = getSecretValuesForRun(runId);
  const stmt = db.prepare(`
    INSERT INTO run_output (run_id, event_type, content, tool_name)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction((evts: typeof events) => {
    for (const e of evts) {
      stmt.run(
        runId,
        e.event_type,
        e.content ? redactSecrets(e.content, secretValues) : null,
        e.tool_name ? redactSecrets(e.tool_name, secretValues) : null,
      );
    }
  });
  insertMany(events);
  db.prepare(`UPDATE runs SET updated_at = unixepoch() WHERE id = ?`).run(runId);
}

export function listRunOutput(runId: string, afterId = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM run_output WHERE run_id = ? AND id > ? ORDER BY id ASC
  `).all(runId, afterId) as RunOutputEvent[];
}

// Fail runs that have exceeded their job's timeout
function failStaleRuns(agentId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stale = db.prepare(`
    SELECT r.id, j.timeout_minutes FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'running'
    AND r.updated_at + (j.timeout_minutes * 60) < ?
  `).all(agentId, now) as { id: string; timeout_minutes: number }[];

  for (const run of stale) {
    db.prepare(`UPDATE runs SET status = 'failed', completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(run.id);
    const actId = uuid();
    db.prepare(`
      INSERT INTO run_activity (id, run_id, author_type, author_name, content, created_at)
      VALUES (?, ?, 'system', 'System', ?, unixepoch())
    `).run(actId, run.id, `Run timed out after ${run.timeout_minutes} minutes without completion.`);

    // Deactivate one-off jobs
    const job = db.prepare(`SELECT one_off FROM jobs WHERE id = (SELECT job_id FROM runs WHERE id = ?)`).get(run.id) as OneOffRow | undefined;
    if (job?.one_off) {
      db.prepare(`UPDATE jobs SET active = 0, next_run_at = NULL, updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`).run(run.id);
    }
  }

  return stale.length;
}

// Agent polling: get next run

export function getAgentNextRun(agentId: string) {
  const db = getDb();

  // 0. Fail any stale running runs that exceeded their timeout
  failStaleRuns(agentId);

  // Wrap in a transaction so run assignment is atomic
  const assignRun = db.transaction(() => {
    // 1. Agent already has a running run? Return nothing (busy)
    const running = db.prepare(`
      SELECT id FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1
    `).get(agentId) as IdRow | undefined;
    if (running) return null;

    // 2. Pending run? (human responded, ready for agent to resume)
    const pendingRun = db.prepare(`
      SELECT id FROM runs
      WHERE agent_id = ? AND status = 'pending'
      ORDER BY updated_at ASC LIMIT 1
    `).get(agentId) as IdRow | undefined;

    if (pendingRun) {
      db.prepare(`UPDATE runs SET status = 'running', updated_at = unixepoch() WHERE id = ?`).run(pendingRun.id);
      return pendingRun.id as string;
    }

    const now = Math.floor(Date.now() / 1000);

    // 3. Scheduled run ready to start? (one-off runs created via dashboard)
    const scheduledRun = db.prepare(`
      SELECT id FROM runs
      WHERE agent_id = ? AND status = 'scheduled' AND scheduled_for <= ?
      ORDER BY scheduled_for ASC LIMIT 1
    `).get(agentId, now) as IdRow | undefined;

    if (scheduledRun) {
      db.prepare(`UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(scheduledRun.id);
      db.prepare(`UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`).run(scheduledRun.id);
      return scheduledRun.id as string;
    }

    // 4. Any recurring job past its schedule time without an active run?
    const readyJob = db.prepare(`
      SELECT j.id, j.agent_id FROM jobs j
      WHERE j.agent_id = ? AND j.active = 1 AND j.one_off = 0
      AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'waiting', 'pending')
      )
      ORDER BY j.next_run_at ASC LIMIT 1
    `).get(agentId, now) as ReadyJobRow | undefined;

    if (readyJob) {
      const run = createRun(readyJob.id, agentId);
      db.prepare(`UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(readyJob.id);
      // Advance next_run_at immediately so the job doesn't re-fire on the next poll
      advanceJobSchedule(readyJob.id);
      return run!.id as string;
    }

    return null;
  });

  const runId = assignRun();
  if (!runId) return null;
  try {
    return buildRunPayload(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addRunActivity(runId, "system", null, "System", `Run failed before agent spawn: ${message}`);
    updateRunStatus(runId, "failed");
    return null;
  }
}

// Workflow polling: get next agentless workflow-only run
export function getNextWorkflowRun() {
  const db = getDb();

  // Fail stale agentless workflow runs
  const now = Math.floor(Date.now() / 1000);
  const stale = db.prepare(`
    SELECT r.id, j.timeout_minutes FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id IS NULL AND r.status = 'running'
    AND r.updated_at + (j.timeout_minutes * 60) < ?
  `).all(now) as { id: string; timeout_minutes: number }[];
  for (const run of stale) {
    db.prepare(`UPDATE runs SET status = 'failed', completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(run.id);
    db.prepare(`
      INSERT INTO run_activity (id, run_id, author_type, author_name, content, created_at)
      VALUES (?, ?, 'system', 'System', ?, unixepoch())
    `).run(uuid(), run.id, `Run timed out after ${run.timeout_minutes} minutes without completion.`);
  }

  const assignRun = db.transaction(() => {
    // Scheduled run ready to start?
    const scheduledRun = db.prepare(`
      SELECT id FROM runs
      WHERE agent_id IS NULL AND status = 'scheduled' AND scheduled_for <= ?
      ORDER BY scheduled_for ASC LIMIT 1
    `).get(now) as IdRow | undefined;

    if (scheduledRun) {
      db.prepare(`UPDATE runs SET status = 'running', claimed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(scheduledRun.id);
      db.prepare(`UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = (SELECT job_id FROM runs WHERE id = ?)`).run(scheduledRun.id);
      return scheduledRun.id as string;
    }

    // Any recurring agentless workflow job past its schedule time?
    const readyJob = db.prepare(`
      SELECT j.id FROM jobs j
      WHERE j.agent_id IS NULL AND j.active = 1 AND j.one_off = 0
      AND j.workflow_only = 1 AND j.workflow_command IS NOT NULL
      AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'waiting', 'pending')
      )
      ORDER BY j.next_run_at ASC LIMIT 1
    `).get(now) as IdRow | undefined;

    if (readyJob) {
      const run = createRun(readyJob.id, null);
      db.prepare(`UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(readyJob.id);
      advanceJobSchedule(readyJob.id);
      return run!.id as string;
    }

    return null;
  });

  const runId = assignRun();
  if (!runId) return null;
  return buildRunPayload(runId);
}

export function peekAgentNext(agentId: string) {
  const db = getDb();

  // Fail stale runs so peek accurately reflects availability
  failStaleRuns(agentId);

  const running = db.prepare(`
    SELECT id FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1
  `).get(agentId) as IdRow | undefined;
  if (running) return { available: false, reason: "busy" };

  const pendingRun = db.prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'pending'
    ORDER BY r.updated_at ASC LIMIT 1
  `).get(agentId) as NamedRunRow | undefined;

  if (pendingRun) {
    return { available: true, type: "pending_resume", run_id: pendingRun.id, job_name: pendingRun.job_name };
  }

  const now = Math.floor(Date.now() / 1000);

  const scheduledRun = db.prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'scheduled' AND r.scheduled_for <= ?
    ORDER BY r.scheduled_for ASC LIMIT 1
  `).get(agentId, now) as NamedRunRow | undefined;

  if (scheduledRun) {
    return { available: true, type: "scheduled_run", run_id: scheduledRun.id, job_name: scheduledRun.job_name };
  }

  const readyJob = db.prepare(`
    SELECT j.id, j.name FROM jobs j
    WHERE j.agent_id = ? AND j.active = 1 AND j.one_off = 0
    AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
    AND NOT EXISTS (SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'waiting', 'pending'))
    ORDER BY j.next_run_at ASC LIMIT 1
  `).get(agentId, now) as NamedJobRow | undefined;

  if (readyJob) {
    return { available: true, type: "scheduled", job_id: readyJob.id, job_name: readyJob.name };
  }

  return { available: false, reason: "nothing_to_do" };
}

function buildRunPayload(runId: string) {
  const db = getDb();
  const run = getRunWithActivity(runId);
  if (!run) return null;

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(run.job_id) as JobPayloadRow | undefined;
  if (!job) return null;

  // Get referenced docs
  const docs = db.prepare(`
    SELECT d.id, d.title, dr.content
    FROM job_docs jd
    JOIN docs d ON jd.doc_id = d.id
    LEFT JOIN doc_revisions dr ON dr.doc_id = d.id
    AND dr.created_at = (SELECT MAX(created_at) FROM doc_revisions WHERE doc_id = d.id)
    WHERE jd.job_id = ?
  `).all(run.job_id) as DocPayloadRow[];

  // Get referenced databases (recent rows from each linked table)
  const linkedDbs = db.prepare(`
    SELECT d.name, d.table_name
    FROM job_databases jd
    JOIN databases d ON jd.database_id = d.id
    WHERE jd.job_id = ?
  `).all(run.job_id) as { name: string; table_name: string }[];

  const data: Record<string, TableDataRow[]> = {};
  for (const d of linkedDbs) {
    data[d.name] = db.prepare(
      `SELECT * FROM "${d.table_name}" ORDER BY rowid DESC LIMIT 100`
    ).all() as TableDataRow[];
  }

  // Decrypt env vars for this job
  const env = {
    ...getDecryptedEnvVarsForJob(run.job_id),
    ...getCredentialBrokerEnvForJob(run.job_id),
  };

  // Run attachments (raw rows; the route serializer adds absolute URLs)
  const attachments = listAttachmentsByRun(run.id);

  // Combine job instructions with any extra trigger-time instructions
  let instructions = job.instructions || null;
  if (run.extra_instructions) {
    instructions = instructions
      ? `${instructions}\n\n---\n\nAdditional instructions for this run:\n${run.extra_instructions}`
      : run.extra_instructions;
  }

  // Agent runtime config (eager) — read live so remote runners pick up
  // dashboard toggles without reconnecting.
  const agentRow = run.agent_id
    ? db.prepare(`
      SELECT eager, composio_cli_enabled, composio_mcp_enabled, composio_toolkits, composio_tools, cli,
        scope_type, workspace_id, project_id
      FROM agents WHERE id = ?
    `).get(run.agent_id) as AgentPayloadRow | undefined
    : undefined;
  const parseList = (value: string | null | undefined) => {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const agent = agentRow ? {
    eager: !!agentRow.eager,
    cli: agentRow.cli || null,
    scope_type: agentRow.scope_type || "global",
    workspace_id: agentRow.workspace_id || null,
    project_id: agentRow.project_id || null,
    composio: {
      cli_enabled: !!agentRow.composio_cli_enabled,
      mcp_enabled: !!agentRow.composio_mcp_enabled,
      toolkits: parseList(agentRow.composio_toolkits),
      tools: parseList(agentRow.composio_tools),
    },
  } : undefined;

  let effectiveProjectId = agentRow?.project_id || null;
  let effectiveWorkspaceId = agentRow?.workspace_id || null;
  if (effectiveProjectId && !effectiveWorkspaceId) {
    const project = db.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(effectiveProjectId) as { workspace_id: string | null } | undefined;
    effectiveWorkspaceId = project?.workspace_id || null;
  }
  if (!effectiveProjectId) {
    const linkedProject = db.prepare(`
      SELECT p.id, p.workspace_id
      FROM project_jobs pj
      JOIN projects p ON p.id = pj.project_id
      WHERE pj.job_id = ?
      LIMIT 1
    `).get(run.job_id) as { id: string; workspace_id: string | null } | undefined;
    effectiveProjectId = linkedProject?.id || null;
    effectiveWorkspaceId = effectiveWorkspaceId || linkedProject?.workspace_id || null;
  }

  const shouldSyncToolkit = agentRow?.cli === "openclaw" || agentRow?.cli === "hermes";
  if (shouldSyncToolkit) {
    importSkillsFromFilesystem();
  }

  const skillQuery = [job.name, instructions].filter(Boolean).join("\n\n");
  const skills = run.agent_id ? resolveSkillsForAgent(run.agent_id, skillQuery) : [];
  const toolkitLibraries = shouldSyncToolkit ? getToolkitLibraries({
    workspaceId: effectiveWorkspaceId,
    projectId: effectiveProjectId,
    agentCli: agentRow?.cli || null,
  }) : undefined;

  return {
    run: { id: run.id, status: run.status, activity: run.activity },
    job: {
      id: job.id,
      name: job.name,
      instructions,
      workflow: job.workflow_command,
      workflow_only: !!job.workflow_only,
      model: job.model || null,
      thinking: job.thinking || null,
      credential_profile_id: job.credential_profile_id || null,
      title_format: job.title_format || null,
      timeout_minutes: job.timeout_minutes ?? 30,
    },
    ...(agent ? { agent } : {}),
    docs,
    data,
    env,
    skills,
    ...(toolkitLibraries ? { toolkit_libraries: toolkitLibraries } : {}),
    ...(shouldSyncToolkit ? { runtime_security: RUNTIME_SECURITY } : {}),
    attachments,
  };
}
