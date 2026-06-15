import { v4 as uuid } from "uuid";
import { decrypt, encrypt } from "../encryption";
import { getDb } from "./schema";

/**
 * Enforce env-var name uniqueness in the query layer (the schema deliberately
 * has no UNIQUE constraint — an org-level and a project-level var may share a
 * name, with project-over-org override). Within a single tier the name must be
 * unique. Throws on collision within the same tier.
 */
function assertNameAvailable(
  orgId: string,
  projectId: string | null,
  name: string,
  excludeId?: string,
) {
  const db = getDb();
  const tierFilter = projectId === null ? "project_id IS NULL" : "project_id = ?";
  const params: any[] = projectId === null ? [orgId, name] : [orgId, projectId, name];
  let sql = `SELECT id FROM env_vars WHERE org_id = ? AND ${tierFilter} AND name = ?`;
  if (excludeId) {
    sql += ` AND id != ?`;
    params.push(excludeId);
  }
  const existing = db.prepare(sql).get(...params) as { id: string } | undefined;
  if (existing) {
    const scope = projectId === null ? "org" : "project";
    throw new Error(`An env var named "${name}" already exists at the ${scope} level`);
  }
}

/**
 * Create an env var. Dual-tier: pass projectId for a project-level var, or null
 * for an org-level var shared across the org.
 */
export function createEnvVar(orgId: string, projectId: string | null, name: string, value: string) {
  const db = getDb();
  assertNameAvailable(orgId, projectId, name);
  const id = uuid();
  const encrypted = encrypt(value);
  db.prepare(
    `INSERT INTO env_vars (id, org_id, project_id, name, encrypted_value) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, orgId, projectId, name, encrypted);
  return getEnvVarById(id);
}

export function getEnvVarById(id: string) {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT id, org_id, project_id, name, pinned, created_at, updated_at FROM env_vars WHERE id = ?`,
      )
      .get(id) as any) || null
  );
}

/**
 * Two-tier list: org-level vars (project_id IS NULL) plus the given project's
 * vars. Pass projectId=null to list only org-level vars.
 */
export function listEnvVars(orgId: string, projectId: string | null = null) {
  const db = getDb();
  const projectFilter = projectId
    ? "AND (project_id = ? OR project_id IS NULL)"
    : "AND project_id IS NULL";
  const params = projectId ? [orgId, projectId] : [orgId];
  return db
    .prepare(
      `SELECT id, org_id, project_id, name, pinned, created_at, updated_at FROM env_vars
     WHERE org_id = ? ${projectFilter}
     ORDER BY pinned DESC, name ASC`,
    )
    .all(...params);
}

export function updateEnvVar(id: string, data: { name?: string; value?: string }) {
  const db = getDb();
  if (data.name !== undefined) {
    const current = db.prepare(`SELECT org_id, project_id FROM env_vars WHERE id = ?`).get(id) as
      | { org_id: string; project_id: string | null }
      | undefined;
    if (current) assertNameAvailable(current.org_id, current.project_id, data.name, id);
  }
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.value !== undefined) {
    fields.push("encrypted_value = ?");
    values.push(encrypt(data.value));
  }
  if (fields.length === 0) return getEnvVarById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE env_vars SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getEnvVarById(id);
}

export function deleteEnvVar(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM env_vars WHERE id = ?`).run(id);
}

export function toggleEnvVarPinned(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE env_vars SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
  return getEnvVarById(id);
}

export function getEnvVarDecryptedValue(id: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT encrypted_value FROM env_vars WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return decrypt(row.encrypted_value);
}

/**
 * Pinned env-var ids for the given scope (org-level + the project's pinned
 * vars). Used to auto-attach pinned vars to new jobs created in a project.
 */
export function listPinnedEnvVarIds(projectId: string): string[] {
  const db = getDb();
  const proj = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(projectId) as
    | { org_id: string }
    | undefined;
  if (!proj) return [];
  return (
    db
      .prepare(
        `SELECT id FROM env_vars WHERE pinned = 1 AND org_id = ? AND (project_id = ? OR project_id IS NULL)`,
      )
      .all(proj.org_id, projectId) as { id: string }[]
  ).map((r) => r.id);
}

// Link/unlink env vars to jobs
export function linkEnvVarToJob(jobId: string, envVarId: string) {
  const db = getDb();
  // An org-level job (project_id NULL) may only link org-level vars of its own
  // org — a project-scoped secret on an org-scoped job would widen its blast
  // radius to the whole org. Routes map this error to 400.
  const job = db.prepare(`SELECT org_id, project_id FROM jobs WHERE id = ?`).get(jobId) as
    | { org_id: string; project_id: string | null }
    | undefined;
  if (job && job.project_id === null) {
    const envVar = db
      .prepare(`SELECT org_id, project_id FROM env_vars WHERE id = ?`)
      .get(envVarId) as { org_id: string; project_id: string | null } | undefined;
    if (!envVar || envVar.project_id !== null || envVar.org_id !== job.org_id) {
      throw new Error("Org-level jobs can only link org-level env vars");
    }
  }
  db.prepare(`INSERT OR IGNORE INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`).run(
    jobId,
    envVarId,
  );
}

export function unlinkEnvVarFromJob(jobId: string, envVarId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_env_vars WHERE job_id = ? AND env_var_id = ?`).run(jobId, envVarId);
}

/**
 * Decrypt the env vars injected into a job's run payload (used by /next).
 *
 * Injection is attachment-driven: only vars explicitly linked to the job via
 * `job_env_vars` are returned — never the org/project tiers at large. Org-level
 * and pinned vars reach a job by being auto-attached at job create (see
 * `listPinnedEnvVarIds`), which makes them real, removable links here. With a
 * single tier there is no precedence to resolve.
 *
 * Returns the decrypted name→value map. (Values stay in the payload; the runner
 * delivers them as real process env vars and lists names-only in the prompt.)
 */
export function getDecryptedEnvVarsForJob(jobId: string): Record<string, string> {
  const db = getDb();

  type Row = { name: string; encrypted_value: string };
  const env: Record<string, string> = {};

  const linkedRows = db
    .prepare(`
    SELECT ev.name, ev.encrypted_value
    FROM job_env_vars jev
    JOIN env_vars ev ON jev.env_var_id = ev.id
    WHERE jev.job_id = ?
  `)
    .all(jobId) as Row[];
  for (const r of linkedRows) env[r.name] = decrypt(r.encrypted_value);

  return env;
}
