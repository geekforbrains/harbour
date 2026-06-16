import { v4 as uuid } from "uuid";
import { defaultRunTitle } from "../run-title";
import type { Gate } from "../runtimes";
import { getNextRunTime } from "../schedule";
import { orgIdForProject } from "./access";
import { deleteRunAttachmentsDir } from "./attachments";
import { listPinnedDocIds } from "./docs";
import { linkEnvVarToJob, listPinnedEnvVarIds } from "./env-vars";
import { resolveRunPlacement } from "./runs";
import { getDb } from "./schema";
import { getTimezone } from "./settings";
import { linkTableToJob, listPinnedTableIds } from "./tables";

export function createJob(
  projectId: string,
  agentId: string | null,
  data: {
    name: string;
    description?: string;
    instructions?: string;
    schedule: string;
    prerun?: Gate | null;
    postrun?: Gate | null;
    postrunGates?: boolean;
    model?: string;
    thinking?: string;
    titleFormat?: string;
    docIds?: string[];
    envVarIds?: string[];
    tableIds?: string[];
    active?: boolean;
  },
) {
  const db = getDb();
  const id = uuid();
  // Agent jobs are always project-level; the org is derived, never passed.
  const orgId = orgIdForProject(projectId);
  if (!orgId) throw new Error("Project not found");
  const nextRunAt =
    data.active !== false ? getNextRunTime(data.schedule, undefined, getTimezone()) : null;

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs (id, org_id, project_id, kind, agent_id, name, description, instructions, schedule, prerun_runtime, prerun_script, postrun_runtime, postrun_script, postrun_gates, model, thinking, title_format, active, next_run_at)
      VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      orgId,
      projectId,
      agentId,
      data.name,
      data.description || null,
      data.instructions || null,
      data.schedule,
      data.prerun?.runtime ?? null,
      data.prerun?.content ?? null,
      data.postrun?.runtime ?? null,
      data.postrun?.content ?? null,
      data.postrunGates ? 1 : 0,
      data.model || null,
      data.thinking || null,
      data.titleFormat?.trim() || null,
      data.active !== false ? 1 : 0,
      nextRunAt,
    );

    // Merge explicitly selected docs/env vars with pinned ones (within this
    // project's scope). Linked via the guard-bearing link functions so the
    // org-level tier rules hold on every path.
    const allDocIds = new Set([...(data.docIds || []), ...listPinnedDocIds(projectId)]);
    for (const docId of allDocIds) linkDocToJob(id, docId);
    const allEnvVarIds = new Set([...(data.envVarIds || []), ...listPinnedEnvVarIds(projectId)]);
    for (const envId of allEnvVarIds) linkEnvVarToJob(id, envId);
    const allTableIds = new Set([...(data.tableIds || []), ...listPinnedTableIds(projectId)]);
    for (const tableId of allTableIds) linkTableToJob(id, tableId);
  });

  create();
  return getJobById(id);
}

/**
 * Create a workflow job. Dual-tier like docs/env_vars/tables: pass projectId
 * for a project-level workflow, or null for an org-level one shared across the
 * org. Scope is fixed at creation — updateJob cannot move a job between tiers.
 * Agent jobs are always project-level (see createJob).
 */
export function createWorkflow(
  orgId: string,
  projectId: string | null,
  data: {
    name: string;
    description?: string;
    schedule: string;
    workflow: Gate;
    timeoutMinutes?: number;
    placement?: string;
    docIds?: string[];
    envVarIds?: string[];
    tableIds?: string[];
    active?: boolean;
  },
) {
  const db = getDb();
  const id = uuid();
  const nextRunAt =
    data.active !== false ? getNextRunTime(data.schedule, undefined, getTimezone()) : null;
  const placement = data.placement?.trim() || "local";

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO jobs (id, org_id, project_id, kind, agent_id, name, description, instructions, schedule, workflow_runtime, workflow_script, placement, timeout_minutes, active, next_run_at)
      VALUES (?, ?, ?, 'workflow', NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      orgId,
      projectId,
      data.name,
      data.description || null,
      data.schedule,
      data.workflow.runtime,
      data.workflow.content,
      placement,
      data.timeoutMinutes ?? 30,
      data.active !== false ? 1 : 0,
      nextRunAt,
    );

    // Pinned resources auto-attach at the job's own tier: project jobs get
    // project + org pinned, org-level jobs get org-level pinned only.
    const pinnedDocIds = projectId
      ? listPinnedDocIds(projectId)
      : (
          db
            .prepare(`SELECT id FROM docs WHERE pinned = 1 AND org_id = ? AND project_id IS NULL`)
            .all(orgId) as { id: string }[]
        ).map((r) => r.id);
    const pinnedEnvVarIds = projectId
      ? listPinnedEnvVarIds(projectId)
      : (
          db
            .prepare(
              `SELECT id FROM env_vars WHERE pinned = 1 AND org_id = ? AND project_id IS NULL`,
            )
            .all(orgId) as { id: string }[]
        ).map((r) => r.id);
    const pinnedTableIds = projectId
      ? listPinnedTableIds(projectId)
      : (
          db
            .prepare(`SELECT id FROM tables WHERE pinned = 1 AND org_id = ? AND project_id IS NULL`)
            .all(orgId) as { id: string }[]
        ).map((r) => r.id);

    // Guard-bearing link functions: an org-level workflow linking a
    // project-scoped doc/env var/table throws here and rolls the creation back.
    const allDocIds = new Set([...(data.docIds || []), ...pinnedDocIds]);
    for (const docId of allDocIds) linkDocToJob(id, docId);
    const allEnvVarIds = new Set([...(data.envVarIds || []), ...pinnedEnvVarIds]);
    for (const envId of allEnvVarIds) linkEnvVarToJob(id, envId);
    const allTableIds = new Set([...(data.tableIds || []), ...pinnedTableIds]);
    for (const tableId of allTableIds) linkTableToJob(id, tableId);
  });

  create();
  return getJobById(id);
}

export function getJobById(id: string) {
  const db = getDb();
  const job = db
    .prepare(`
    SELECT j.*, a.name as agent_name, a.color as agent_color
    FROM jobs j
    LEFT JOIN agents a ON j.agent_id = a.id
    WHERE j.id = ?
  `)
    .get(id) as any;
  if (!job) return null;

  const docs = db
    .prepare(`
    SELECT d.id, d.title FROM job_docs jd
    JOIN docs d ON jd.doc_id = d.id
    WHERE jd.job_id = ?
  `)
    .all(id);

  const tables = db
    .prepare(`
    SELECT t.id, t.name, t.table_name FROM job_tables jt
    JOIN tables t ON jt.table_id = t.id
    WHERE jt.job_id = ?
  `)
    .all(id);

  const envVars = db
    .prepare(`
    SELECT ev.id, ev.name FROM job_env_vars jev
    JOIN env_vars ev ON jev.env_var_id = ev.id
    WHERE jev.job_id = ?
  `)
    .all(id);

  return { ...job, docs, tables, envVars };
}

export function listJobsByAgent(agentId: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id) as total_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs
    FROM jobs j WHERE j.kind = 'agent' AND j.agent_id = ? ORDER BY j.name
  `)
    .all(agentId);
}

/**
 * Two-tier list: org-level jobs (project_id IS NULL — workflows only) plus the
 * given project's jobs. Pass projectId=null to list only org-level jobs.
 */
export function listAllJobs(orgId: string, projectId: string | null = null) {
  const db = getDb();
  const projectFilter = projectId
    ? "AND (j.project_id = ? OR j.project_id IS NULL)"
    : "AND j.project_id IS NULL";
  const params = projectId ? [orgId, projectId] : [orgId];
  return db
    .prepare(`
    SELECT j.*, a.name as agent_name, a.color as agent_color,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status NOT IN ('skipped')) as total_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'skipped') as skipped_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'waiting') as waiting_runs,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id AND status = 'pending') as pending_runs
    FROM jobs j
    LEFT JOIN agents a ON j.agent_id = a.id
    WHERE j.org_id = ? ${projectFilter}
    ORDER BY j.name
  `)
    .all(...params);
}

// Scope (org_id/project_id) is fixed at creation — deliberately absent from
// the field whitelist so a job can never move between tiers.
export function updateJob(
  id: string,
  data: {
    name?: string;
    description?: string;
    instructions?: string;
    schedule?: string;
    prerun?: Gate | null;
    postrun?: Gate | null;
    postrunGates?: boolean;
    workflow?: Gate | null;
    model?: string;
    thinking?: string;
    titleFormat?: string;
    timeoutMinutes?: number;
    placement?: string;
    docIds?: string[];
    envVarIds?: string[];
    tableIds?: string[];
    active?: boolean;
    nextRunAt?: number;
  },
) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.instructions !== undefined) {
    fields.push("instructions = ?");
    values.push(data.instructions);
  }
  if (data.schedule !== undefined) {
    fields.push("schedule = ?");
    values.push(data.schedule);
  }
  if (data.prerun !== undefined) {
    fields.push("prerun_runtime = ?", "prerun_script = ?");
    values.push(data.prerun?.runtime ?? null, data.prerun?.content ?? null);
  }
  if (data.postrun !== undefined) {
    fields.push("postrun_runtime = ?", "postrun_script = ?");
    values.push(data.postrun?.runtime ?? null, data.postrun?.content ?? null);
  }
  if (data.postrunGates !== undefined) {
    fields.push("postrun_gates = ?");
    values.push(data.postrunGates ? 1 : 0);
  }
  if (data.workflow !== undefined) {
    fields.push("workflow_runtime = ?", "workflow_script = ?");
    values.push(data.workflow?.runtime ?? null, data.workflow?.content ?? null);
  }
  if (data.model !== undefined) {
    fields.push("model = ?");
    values.push(data.model || null);
  }
  if (data.thinking !== undefined) {
    fields.push("thinking = ?");
    values.push(data.thinking || null);
  }
  if (data.titleFormat !== undefined) {
    fields.push("title_format = ?");
    values.push(data.titleFormat?.trim() || null);
  }
  if (data.timeoutMinutes !== undefined) {
    fields.push("timeout_minutes = ?");
    values.push(data.timeoutMinutes);
  }
  if (data.placement !== undefined) {
    // Workflow jobs route by their own placement; agent jobs inherit the agent's
    // (this is a no-op for them).
    fields.push("placement = ?");
    values.push(data.placement.trim() || "local");
  }

  if (data.active !== undefined) {
    fields.push("active = ?");
    values.push(data.active ? 1 : 0);
    // When activating a job that has no next_run_at, compute it from the schedule
    if (data.active && data.nextRunAt === undefined) {
      const job = db.prepare(`SELECT schedule, next_run_at FROM jobs WHERE id = ?`).get(id) as any;
      if (job && !job.next_run_at && job.schedule) {
        const schedule = data.schedule || job.schedule;
        const nextRunAt = getNextRunTime(schedule, undefined, getTimezone());
        if (nextRunAt !== null) {
          fields.push("next_run_at = ?");
          values.push(nextRunAt);
        }
      }
    }
  }
  if (data.nextRunAt !== undefined) {
    fields.push("next_run_at = ?");
    values.push(data.nextRunAt);
  }

  const update = db.transaction(() => {
    if (fields.length > 0) {
      fields.push("updated_at = unixepoch()");
      db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
    }
    // Replacement links go through the guard-bearing link functions: an
    // org-level job replacing its links with a project-scoped resource throws
    // and rolls the whole update back (routes map it to 400).
    if (data.docIds !== undefined) {
      db.prepare(`DELETE FROM job_docs WHERE job_id = ?`).run(id);
      for (const docId of data.docIds) linkDocToJob(id, docId);
    }
    if (data.envVarIds !== undefined) {
      db.prepare(`DELETE FROM job_env_vars WHERE job_id = ?`).run(id);
      for (const envId of data.envVarIds) linkEnvVarToJob(id, envId);
    }
    if (data.tableIds !== undefined) {
      db.prepare(`DELETE FROM job_tables WHERE job_id = ?`).run(id);
      for (const tableId of data.tableIds) linkTableToJob(id, tableId);
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

/**
 * Manually fire a scheduled run for a job (dashboard "Run now" / debug). One-off
 * runs no longer exist in v2 — this is the only ad-hoc trigger path. The run
 * inherits the job's org and project (denormalized onto the run; project may be
 * NULL for org-level workflows).
 */
export function triggerJobRun(jobId: string, extraInstructions?: string) {
  const db = getDb();
  const job = db
    .prepare(`SELECT id, org_id, project_id, agent_id, name, placement FROM jobs WHERE id = ?`)
    .get(jobId) as any;
  if (!job) return null;

  const runId = uuid();
  const now = Math.floor(Date.now() / 1000);
  const title = defaultRunTitle(job.name, now);
  // Denormalize placement onto the run: agent runs route by their agent's
  // placement, workflow runs by the job's. Shared resolver keeps this in lockstep
  // with createRun's recurring-materialization path.
  const placement = resolveRunPlacement(job.agent_id || null, job.placement);

  // Run + its seeded activity log must land atomically (repo convention: run
  // creation is transactional) — otherwise a failed activity insert leaves a
  // scheduled run with silently-dropped instructions.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO runs (id, org_id, project_id, job_id, agent_id, status, placement, scheduled_for, extra_instructions, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      job.org_id,
      job.project_id,
      jobId,
      job.agent_id || null,
      placement,
      now,
      extraInstructions || null,
      title,
      now,
      now,
    );

    if (extraInstructions) {
      db.prepare(`
        INSERT INTO run_activity (id, run_id, author_type, author_name, content, created_at)
        VALUES (?, ?, 'system', 'System', ?, ?)
      `).run(uuid(), runId, `Additional instructions:\n${extraInstructions}`, now);
    }
  })();

  return { jobId, runId };
}

export function linkDocToJob(jobId: string, docId: string) {
  const db = getDb();
  // An org-level job (project_id NULL) may only link org-level resources of its
  // own org — a project-scoped doc on an org-scoped job would widen the doc's
  // blast radius to the whole org. Routes map this error to 400.
  const job = db.prepare(`SELECT org_id, project_id FROM jobs WHERE id = ?`).get(jobId) as
    | { org_id: string; project_id: string | null }
    | undefined;
  if (job && job.project_id === null) {
    const doc = db.prepare(`SELECT org_id, project_id FROM docs WHERE id = ?`).get(docId) as
      | { org_id: string; project_id: string | null }
      | undefined;
    if (!doc || doc.project_id !== null || doc.org_id !== job.org_id) {
      throw new Error("Org-level jobs can only link org-level docs");
    }
  }
  db.prepare(`INSERT OR IGNORE INTO job_docs (job_id, doc_id) VALUES (?, ?)`).run(jobId, docId);
}

export function unlinkDocFromJob(jobId: string, docId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_docs WHERE job_id = ? AND doc_id = ?`).run(jobId, docId);
}

// linkTableToJob and unlinkTableFromJob are in tables.ts

export function touchJobRan(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE jobs SET last_run_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
}

// Advance a job's next_run_at based on its schedule.
// Called after a run completes (done/failed/skipped).
export function advanceJobSchedule(jobId: string) {
  const db = getDb();
  const job = db.prepare(`SELECT schedule FROM jobs WHERE id = ?`).get(jobId) as any;
  if (!job?.schedule) return;

  const nextRunAt = getNextRunTime(job.schedule, undefined, getTimezone());
  if (nextRunAt !== null) {
    db.prepare(`UPDATE jobs SET next_run_at = ?, updated_at = unixepoch() WHERE id = ?`).run(
      nextRunAt,
      jobId,
    );
  }
}
