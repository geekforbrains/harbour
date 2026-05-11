import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import { getDecryptedEnvVarsForJob } from "./env-vars";
import { advanceJobSchedule } from "./jobs";
import { listAttachmentsByRun, deleteRunAttachmentsDir } from "./attachments";
import { defaultRunTitle } from "../run-title";

export function createRun(jobId: string, agentId: string | null) {
  const db = getDb();
  const id = uuid();
  const job = db.prepare(`SELECT name FROM jobs WHERE id = ?`).get(jobId) as { name: string } | undefined;
  const title = job ? defaultRunTitle(job.name, Math.floor(Date.now() / 1000)) : null;
  db.prepare(`
    INSERT INTO runs (id, job_id, agent_id, status, claimed_at, title)
    VALUES (?, ?, ?, 'running', unixepoch(), ?)
  `).run(id, jobId, agentId || null, title);
  return getRunById(id);
}

export function getRunById(id: string) {
  const db = getDb();
  const run = db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.workflow_only as job_workflow_only, j.agent_id, a.name as agent_name, a.type as agent_type, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.id = ?
  `).get(id) as any;
  return run || null;
}

export function getRunWithActivity(id: string) {
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
      const job = db.prepare(`SELECT one_off FROM jobs WHERE id = ?`).get(run.job_id) as any;
      if (job?.one_off) {
        db.prepare(`UPDATE jobs SET active = 0, next_run_at = NULL, updated_at = unixepoch() WHERE id = ?`).run(run.job_id);
      } else {
        advanceJobSchedule(run.job_id);
      }
    }
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
  const row = db.prepare(`SELECT kill_requested_at FROM runs WHERE id = ?`).get(id) as any;
  return !!row?.kill_requested_at;
}

export function deleteRun(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
  deleteRunAttachmentsDir(id);
}

export function listRunsByJob(jobId: string, limit = 10, opts: { includeSkipped?: boolean; offset?: number } = {}) {
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

export function listRunsByAgent(agentId: string, limit = 10, opts: { includeSkipped?: boolean; offset?: number } = {}) {
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

export function listScheduledRuns(projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)` : "";
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'scheduled' ${projectFilter}
    ORDER BY r.scheduled_for ASC
  `).all(...(projectId ? [projectId] : []));
}

export function listRunningRuns(projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)` : "";
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status = 'running' ${projectFilter}
    ORDER BY r.updated_at DESC
  `).all(...(projectId ? [projectId] : []));
}

export function listWaitingRuns(projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)` : "";
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('waiting', 'pending') ${projectFilter}
    ORDER BY r.updated_at ASC
  `).all(...(projectId ? [projectId] : []));
}

export function listRecentRuns(limit = 10, projectId?: string) {
  const db = getDb();
  const projectFilter = projectId ? `AND r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)` : "";
  return db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.active as job_active, j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only, a.name as agent_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE r.status IN ('done', 'failed', 'killed') ${projectFilter}
    ORDER BY r.completed_at DESC LIMIT ?
  `).all(...(projectId ? [projectId, limit] : [limit]));
}

const ALL_STATUSES = ["scheduled", "running", "waiting", "pending", "done", "failed", "killed", "skipped"] as const;
type RunStatus = (typeof ALL_STATUSES)[number];

export type RunsHistoryFilters = {
  statuses?: RunStatus[];        // omit/empty → all except 'skipped' (use includeSkipped to opt in)
  includeSkipped?: boolean;      // only meaningful if statuses is omitted
  agentId?: string;
  jobId?: string;
  projectId?: string;
  from?: number;                 // unix seconds (inclusive)
  to?: number;                   // unix seconds (inclusive)
  sort?: "newest" | "oldest";
};

export function listRunsHistory(filters: RunsHistoryFilters = {}, limit = 25, offset = 0) {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];

  // Status filter: validate against allowed set; default excludes 'skipped'
  let statuses = filters.statuses?.filter((s): s is RunStatus => (ALL_STATUSES as readonly string[]).includes(s)) ?? [];
  if (statuses.length === 0) {
    statuses = ALL_STATUSES.filter(s => filters.includeSkipped || s !== "skipped");
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
    where.push(`r.job_id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)`);
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

  const rows = db.prepare(`
    SELECT r.*, j.name as job_name, j.one_off, j.active as job_active,
           j.workflow_command as job_workflow_command, j.workflow_only as job_workflow_only,
           a.name as agent_name, a.type as agent_type, a.cli as agent_cli
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    LEFT JOIN agents a ON r.agent_id = a.id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(r.completed_at, r.created_at) ${order}, r.created_at ${order}
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit + 1, safeOffset) as any[];

  const hasMore = rows.length > safeLimit;
  return { runs: hasMore ? rows.slice(0, safeLimit) : rows, hasMore };
}

// Activity log

export function addRunActivity(runId: string, authorType: string, authorId: string | null, authorName: string, content: string) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO run_activity (id, run_id, author_type, author_id, author_name, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId, authorType, authorId, authorName, content);
  db.prepare(`UPDATE runs SET updated_at = unixepoch() WHERE id = ?`).run(runId);
  return { id, run_id: runId, author_type: authorType, author_id: authorId, author_name: authorName, content, created_at: Math.floor(Date.now() / 1000) };
}

export function listRunActivity(runId: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM run_activity WHERE run_id = ? ORDER BY created_at ASC`).all(runId);
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
  const stmt = db.prepare(`
    INSERT INTO run_output (run_id, event_type, content, tool_name)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction((evts: typeof events) => {
    for (const e of evts) {
      stmt.run(runId, e.event_type, e.content || null, e.tool_name || null);
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
    const job = db.prepare(`SELECT one_off FROM jobs WHERE id = (SELECT job_id FROM runs WHERE id = ?)`).get(run.id) as any;
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
    `).get(agentId) as any;
    if (running) return null;

    // 2. Pending run? (human responded, ready for agent to resume)
    const pendingRun = db.prepare(`
      SELECT id FROM runs
      WHERE agent_id = ? AND status = 'pending'
      ORDER BY updated_at ASC LIMIT 1
    `).get(agentId) as any;

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
    `).get(agentId, now) as any;

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
    `).get(agentId, now) as any;

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
  return buildRunPayload(runId);
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
    `).get(now) as any;

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
    `).get(now) as any;

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
  `).get(agentId) as any;
  if (running) return { available: false, reason: "busy" };

  const pendingRun = db.prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'pending'
    ORDER BY r.updated_at ASC LIMIT 1
  `).get(agentId) as any;

  if (pendingRun) {
    return { available: true, type: "pending_resume", run_id: pendingRun.id, job_name: pendingRun.job_name };
  }

  const now = Math.floor(Date.now() / 1000);

  const scheduledRun = db.prepare(`
    SELECT r.id, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.agent_id = ? AND r.status = 'scheduled' AND r.scheduled_for <= ?
    ORDER BY r.scheduled_for ASC LIMIT 1
  `).get(agentId, now) as any;

  if (scheduledRun) {
    return { available: true, type: "scheduled_run", run_id: scheduledRun.id, job_name: scheduledRun.job_name };
  }

  const readyJob = db.prepare(`
    SELECT j.id, j.name FROM jobs j
    WHERE j.agent_id = ? AND j.active = 1 AND j.one_off = 0
    AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
    AND NOT EXISTS (SELECT 1 FROM runs WHERE job_id = j.id AND status IN ('scheduled', 'running', 'waiting', 'pending'))
    ORDER BY j.next_run_at ASC LIMIT 1
  `).get(agentId, now) as any;

  if (readyJob) {
    return { available: true, type: "scheduled", job_id: readyJob.id, job_name: readyJob.name };
  }

  return { available: false, reason: "nothing_to_do" };
}

function buildRunPayload(runId: string) {
  const db = getDb();
  const run = getRunWithActivity(runId);
  if (!run) return null;

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(run.job_id) as any;

  // Get referenced docs
  const docs = db.prepare(`
    SELECT d.id, d.title, dr.content
    FROM job_docs jd
    JOIN docs d ON jd.doc_id = d.id
    LEFT JOIN doc_revisions dr ON dr.doc_id = d.id
    AND dr.created_at = (SELECT MAX(created_at) FROM doc_revisions WHERE doc_id = d.id)
    WHERE jd.job_id = ?
  `).all(run.job_id);

  // Get referenced databases (recent rows from each linked table)
  const linkedDbs = db.prepare(`
    SELECT d.name, d.table_name
    FROM job_databases jd
    JOIN databases d ON jd.database_id = d.id
    WHERE jd.job_id = ?
  `).all(run.job_id) as { name: string; table_name: string }[];

  const data: Record<string, any> = {};
  for (const d of linkedDbs) {
    data[d.name] = db.prepare(
      `SELECT * FROM "${d.table_name}" ORDER BY rowid DESC LIMIT 100`
    ).all();
  }

  // Decrypt env vars for this job
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

  // Prepend the title-setting preamble for agent runs. Workflow-only runs
  // have no LLM and can't honor it. The preamble references the resolved
  // `set_title` endpoint that the route adds to the api section below.
  if (run.agent_id) {
    const formatHint = job.title_format
      ? `Format guide: ${job.title_format}`
      : `Use a short sentence summarizing what this run is doing.`;
    const preamble =
      `Before doing anything else, set a short title for this run via the ` +
      `\`set_title\` endpoint in the \`api\` section (max 80 chars). ${formatHint}`;
    instructions = instructions ? `${preamble}\n\n---\n\n${instructions}` : preamble;
  }

  // Agent runtime config (eager) — read live so remote runners pick up
  // dashboard toggles without reconnecting.
  const agentRow = run.agent_id
    ? db.prepare(`SELECT eager FROM agents WHERE id = ?`).get(run.agent_id) as { eager: number } | undefined
    : undefined;
  const agent = agentRow ? { eager: !!agentRow.eager } : undefined;

  return {
    run: { id: run.id, status: run.status, title: run.title || null, activity: run.activity },
    job: {
      id: job.id,
      name: job.name,
      instructions,
      workflow: job.workflow_command,
      workflow_only: !!job.workflow_only,
      model: job.model || null,
      thinking: job.thinking || null,
      title_format: job.title_format || null,
      timeout_minutes: job.timeout_minutes ?? 30,
    },
    ...(agent ? { agent } : {}),
    docs,
    data,
    env,
    attachments,
  };
}

