import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import { getNextRunTime } from "../schedule";
import { listPinnedDocIds } from "./docs";
import { listPinnedEnvVarIds } from "./env-vars";
import { getTimezone } from "./settings";
import { deleteRunAttachmentsDir } from "./attachments";
import { defaultRunTitle } from "../run-title";

type DbValue = string | number | null;
type JobDetailRow = {
  id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  instructions: string | null;
  schedule: string;
  workflow_command: string | null;
  workflow_only: number;
  credential_profile_id: string | null;
  title_format: string | null;
  active: number;
  next_run_at: number | null;
  agent_name?: string | null;
};
type LinkedDocRow = { id: string; title: string };
type LinkedDatabaseRow = { id: string; name: string; table_name: string };
type LinkedEnvVarRow = { id: string; name: string };
type JobWithRelations = JobDetailRow & {
  docs: LinkedDocRow[];
  databases: LinkedDatabaseRow[];
  envVars: LinkedEnvVarRow[];
};
type JobAgentRow = {
  id: string;
  agent_id: string | null;
};
type JobScheduleRow = {
  schedule: string | null;
};

export function createJob(agentId: string | null, data: {
  name: string;
  description?: string;
  instructions?: string;
  schedule: string;
  workflowCommand?: string;
  workflowOnly?: boolean;
  model?: string;
  thinking?: string;
  titleFormat?: string;
  docIds?: string[];
  envVarIds?: string[];
  credentialProfileId?: string | null;
  active?: boolean;
}) {
  const db = getDb();
  const id = uuid();
  const nextRunAt = data.active !== false ? getNextRunTime(data.schedule, undefined, getTimezone()) : null;

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs (
        id, agent_id, name, description, instructions, schedule, workflow_command,
        workflow_only, model, thinking, credential_profile_id, title_format, active, next_run_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, agentId, data.name, data.description || null,
      data.instructions || null, data.schedule,
      data.workflowCommand || null, data.workflowOnly ? 1 : 0,
      data.model || null, data.thinking || null, data.credentialProfileId || null,
      data.titleFormat?.trim() || null,
      data.active !== false ? 1 : 0, nextRunAt
    );

    // Merge explicitly selected docs/env vars with pinned ones
    const allDocIds = new Set([...(data.docIds || []), ...listPinnedDocIds()]);
    if (allDocIds.size > 0) {
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_docs (job_id, doc_id) VALUES (?, ?)`);
      for (const docId of allDocIds) linkStmt.run(id, docId);
    }
    const allEnvVarIds = new Set([...(data.envVarIds || []), ...listPinnedEnvVarIds()]);
    if (allEnvVarIds.size > 0) {
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`);
      for (const envId of allEnvVarIds) linkStmt.run(id, envId);
    }
  });

  create();
  return getJobById(id);
}

export function getJobById(id: string): JobWithRelations | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT j.*, a.name as agent_name
      FROM jobs j
      LEFT JOIN agents a ON j.agent_id = a.id
      WHERE j.id = ?
  `).get(id) as JobDetailRow | undefined;
  if (!job) return null;

  const docs = db.prepare(`
    SELECT d.id, d.title FROM job_docs jd
    JOIN docs d ON jd.doc_id = d.id
    WHERE jd.job_id = ?
  `).all(id) as LinkedDocRow[];

  const databases = db.prepare(`
    SELECT d.id, d.name, d.table_name FROM job_databases jd
    JOIN databases d ON jd.database_id = d.id
    WHERE jd.job_id = ?
  `).all(id) as LinkedDatabaseRow[];

  const envVars = db.prepare(`
    SELECT ev.id, ev.name FROM job_env_vars jev
    JOIN env_vars ev ON jev.env_var_id = ev.id
    WHERE jev.job_id = ?
  `).all(id) as LinkedEnvVarRow[];

  return { ...job, docs, databases, envVars };
}

export function listJobsByAgent(agentId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id) as total_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs
    FROM jobs j WHERE j.agent_id = ? AND j.one_off = 0 ORDER BY j.name
  `).all(agentId);
}

export function listAllJobs(projectId?: string, workspaceId?: string) {
  const db = getDb();
  if (projectId) {
    return db.prepare(`
      SELECT j.*, a.name as agent_name,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status NOT IN ('skipped')) as total_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs
      FROM jobs j
      LEFT JOIN agents a ON j.agent_id = a.id
      WHERE j.one_off = 0
      AND j.id != 'harbour-toolkit-library-sync-7am'
      AND j.id IN (SELECT job_id FROM project_jobs WHERE project_id = ?)
      ORDER BY j.name
    `).all(projectId);
  }
  if (workspaceId) {
    return db.prepare(`
      SELECT j.*, a.name as agent_name,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status NOT IN ('skipped')) as total_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
        (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs
      FROM jobs j
      LEFT JOIN agents a ON j.agent_id = a.id
      WHERE j.one_off = 0
      AND j.id != 'harbour-toolkit-library-sync-7am'
      AND (
        a.workspace_id = ?
        OR j.id IN (
          SELECT pj.job_id
          FROM project_jobs pj
          JOIN projects p ON p.id = pj.project_id
          WHERE p.workspace_id = ?
        )
      )
      ORDER BY j.name
    `).all(workspaceId, workspaceId);
  }
  return db.prepare(`
    SELECT j.*, a.name as agent_name,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status NOT IN ('skipped')) as total_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs
    FROM jobs j
    LEFT JOIN agents a ON j.agent_id = a.id
    WHERE j.one_off = 0
    AND j.id != 'harbour-toolkit-library-sync-7am'
    ORDER BY j.name
  `).all();
}

export function updateJob(id: string, data: {
  name?: string;
  description?: string;
  instructions?: string;
  schedule?: string;
  workflowCommand?: string;
  workflowOnly?: boolean;
  model?: string;
  thinking?: string;
  titleFormat?: string;
  timeoutMinutes?: number;
  docIds?: string[];
  envVarIds?: string[];
  credentialProfileId?: string | null;
  active?: boolean;
  nextRunAt?: number;
}) {
  const db = getDb();
  const fields: string[] = [];
  const values: DbValue[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description); }
  if (data.instructions !== undefined) { fields.push("instructions = ?"); values.push(data.instructions); }
  if (data.schedule !== undefined) { fields.push("schedule = ?"); values.push(data.schedule); }
  if (data.workflowCommand !== undefined) { fields.push("workflow_command = ?"); values.push(data.workflowCommand); }
  if (data.workflowOnly !== undefined) { fields.push("workflow_only = ?"); values.push(data.workflowOnly ? 1 : 0); }
  if (data.model !== undefined) { fields.push("model = ?"); values.push(data.model || null); }
  if (data.thinking !== undefined) { fields.push("thinking = ?"); values.push(data.thinking || null); }
  if (data.credentialProfileId !== undefined) { fields.push("credential_profile_id = ?"); values.push(data.credentialProfileId || null); }
  if (data.titleFormat !== undefined) { fields.push("title_format = ?"); values.push(data.titleFormat?.trim() || null); }
  if (data.timeoutMinutes !== undefined) { fields.push("timeout_minutes = ?"); values.push(data.timeoutMinutes); }

  if (data.active !== undefined) {
    fields.push("active = ?"); values.push(data.active ? 1 : 0);
    // When activating a job that has no next_run_at, compute it from the schedule
    if (data.active && data.nextRunAt === undefined) {
      const job = db.prepare(`SELECT schedule, next_run_at FROM jobs WHERE id = ?`).get(id) as Pick<JobDetailRow, "schedule" | "next_run_at"> | undefined;
      if (job && !job.next_run_at && job.schedule) {
        const schedule = data.schedule || job.schedule;
        const nextRunAt = getNextRunTime(schedule, undefined, getTimezone());
        if (nextRunAt !== null) {
          fields.push("next_run_at = ?"); values.push(nextRunAt);
        }
      }
    }
  }
  if (data.nextRunAt !== undefined) { fields.push("next_run_at = ?"); values.push(data.nextRunAt); }

  const update = db.transaction(() => {
    if (fields.length > 0) {
      fields.push("updated_at = unixepoch()");
      db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
    }
    if (data.docIds !== undefined) {
      db.prepare(`DELETE FROM job_docs WHERE job_id = ?`).run(id);
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_docs (job_id, doc_id) VALUES (?, ?)`);
      for (const docId of data.docIds) linkStmt.run(id, docId);
    }
    if (data.envVarIds !== undefined) {
      db.prepare(`DELETE FROM job_env_vars WHERE job_id = ?`).run(id);
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`);
      for (const envId of data.envVarIds) linkStmt.run(id, envId);
    }
  });
  update();
  return getJobById(id);
}

export function deleteJob(id: string) {
  const db = getDb();
  const runIds = db.prepare(`SELECT id FROM runs WHERE job_id = ?`).all(id) as { id: string }[];
  db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
  for (const r of runIds) deleteRunAttachmentsDir(r.id);
}

export function createOneOffRun(agentId: string, data: {
  name: string;
  instructions?: string;
  docIds?: string[];
  envVarIds?: string[];
  credentialProfileId?: string | null;
  runAt?: number;
}) {
  const db = getDb();
  const jobId = uuid();
  const runId = uuid();
  const now = Math.floor(Date.now() / 1000);
  const runAt = data.runAt || now;

  const create = db.transaction(() => {
    // Create the backing job (hidden, one_off)
    db.prepare(`
      INSERT INTO jobs (id, agent_id, name, instructions, schedule, one_off, active, next_run_at, credential_profile_id)
      VALUES (?, ?, ?, ?, '{}', 1, 1, ?, ?)
    `).run(jobId, agentId, data.name, data.instructions || null, runAt, data.credentialProfileId || null);

    // Merge explicitly selected docs with pinned docs
    const allDocIds = new Set([...(data.docIds || []), ...listPinnedDocIds()]);
    if (allDocIds.size > 0) {
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_docs (job_id, doc_id) VALUES (?, ?)`);
      for (const docId of allDocIds) linkStmt.run(jobId, docId);
    }

    // Merge explicitly selected env vars with pinned env vars
    const allEnvVarIds = new Set([...(data.envVarIds || []), ...listPinnedEnvVarIds()]);
    if (allEnvVarIds.size > 0) {
      const linkStmt = db.prepare(`INSERT OR IGNORE INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`);
      for (const envId of allEnvVarIds) linkStmt.run(jobId, envId);
    }

    // Create the run immediately with 'scheduled' status
    const title = defaultRunTitle(data.name, now);
    db.prepare(`
      INSERT INTO runs (id, job_id, agent_id, status, scheduled_for, title, created_at, updated_at)
      VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?)
    `).run(runId, jobId, agentId, runAt, title, now, now);
  });

  create();
  return { jobId, runId };
}

export function triggerJobRun(jobId: string, extraInstructions?: string) {
  const db = getDb();
  const job = db.prepare(`SELECT id, agent_id, name FROM jobs WHERE id = ?`).get(jobId) as (JobAgentRow & { name: string }) | undefined;
  if (!job) return null;

  const runId = uuid();
  const now = Math.floor(Date.now() / 1000);
  const title = defaultRunTitle(job.name, now);

  db.prepare(`
    INSERT INTO runs (id, job_id, agent_id, status, scheduled_for, extra_instructions, title, created_at, updated_at)
    VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)
  `).run(runId, jobId, job.agent_id || null, now, extraInstructions || null, title, now, now);

  if (extraInstructions) {
    db.prepare(`
      INSERT INTO run_activity (id, run_id, author_type, author_name, content, created_at)
      VALUES (?, ?, 'system', 'System', ?, ?)
    `).run(uuid(), runId, `Additional instructions:\n${extraInstructions}`, now);
  }

  return { jobId, runId };
}

export function linkDocToJob(jobId: string, docId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO job_docs (job_id, doc_id) VALUES (?, ?)`).run(jobId, docId);
}

export function unlinkDocFromJob(jobId: string, docId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_docs WHERE job_id = ? AND doc_id = ?`).run(jobId, docId);
}

// linkDatabaseToJob and unlinkDatabaseFromJob are in database.ts

export function touchJobRan(id: string) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(id);
}

// Advance a job's next_run_at based on its schedule.
// Called after a run completes (done/failed/skipped).
export function advanceJobSchedule(jobId: string) {
  const db = getDb();
  const job = db.prepare(`SELECT schedule FROM jobs WHERE id = ?`).get(jobId) as JobScheduleRow | undefined;
  if (!job?.schedule) return;

  const nextRunAt = getNextRunTime(job.schedule, undefined, getTimezone());
  if (nextRunAt !== null) {
    db.prepare(`UPDATE jobs SET next_run_at = ?, updated_at = unixepoch() WHERE id = ?`).run(nextRunAt, jobId);
  }
}
