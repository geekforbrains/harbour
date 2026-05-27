import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import { encrypt, decrypt } from "../encryption";

/**
 * Enforce env-var name uniqueness in the query layer (the schema deliberately
 * has no UNIQUE constraint — an org-level and a project-level var may share a
 * name, with project-over-org override). Within a single tier the name must be
 * unique. Throws on collision within the same tier.
 */
function assertNameAvailable(orgId: string, projectId: string | null, name: string, excludeId?: string) {
  const db = getDb();
  const tierFilter = projectId === null ? "project_id IS NULL" : "project_id = ?";
  const params: any[] = projectId === null ? [orgId, name] : [orgId, projectId, name];
  let sql = `SELECT id FROM env_vars WHERE org_id = ? AND ${tierFilter} AND name = ?`;
  if (excludeId) { sql += ` AND id != ?`; params.push(excludeId); }
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
    `INSERT INTO env_vars (id, org_id, project_id, name, encrypted_value) VALUES (?, ?, ?, ?, ?)`
  ).run(id, orgId, projectId, name, encrypted);
  return getEnvVarById(id);
}

export function getEnvVarById(id: string) {
  const db = getDb();
  return db.prepare(
    `SELECT id, org_id, project_id, name, pinned, created_at, updated_at FROM env_vars WHERE id = ?`
  ).get(id) as any || null;
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
  return db.prepare(
    `SELECT id, org_id, project_id, name, pinned, created_at, updated_at FROM env_vars
     WHERE org_id = ? ${projectFilter}
     ORDER BY pinned DESC, name ASC`
  ).all(...params);
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
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.value !== undefined) { fields.push("encrypted_value = ?"); values.push(encrypt(data.value)); }
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
  db.prepare(`UPDATE env_vars SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`).run(id);
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
  const proj = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(projectId) as { org_id: string } | undefined;
  if (!proj) return [];
  return (db.prepare(
    `SELECT id FROM env_vars WHERE pinned = 1 AND org_id = ? AND (project_id = ? OR project_id IS NULL)`
  ).all(proj.org_id, projectId) as { id: string }[]).map(r => r.id);
}

// Link/unlink env vars to jobs
export function linkEnvVarToJob(jobId: string, envVarId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`).run(jobId, envVarId);
}

export function unlinkEnvVarFromJob(jobId: string, envVarId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_env_vars WHERE job_id = ? AND env_var_id = ?`).run(jobId, envVarId);
}

/**
 * Decrypt the composed env vars for a job (used by the /next payload).
 *
 * Composition (per the v2 resource model) = all org-level vars of the job's org
 * + all project-level vars of the job's project + the job's explicitly linked
 * vars. Name collisions resolve by precedence:
 *
 *     job-linked  >  project-level  >  org-level   (more specific wins)
 *
 * Returns the final decrypted name→value map.
 */
export function getDecryptedEnvVarsForJob(jobId: string): Record<string, string> {
  const db = getDb();

  // Resolve the job's scope (its project and that project's org).
  const scope = db.prepare(`
    SELECT j.project_id, p.org_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).get(jobId) as { project_id: string; org_id: string } | undefined;
  if (!scope) return {};

  type Row = { name: string; encrypted_value: string };
  const env: Record<string, string> = {};

  // Tier 1 — org-level (project_id IS NULL). Lowest precedence.
  const orgRows = db.prepare(`
    SELECT name, encrypted_value FROM env_vars
    WHERE org_id = ? AND project_id IS NULL
  `).all(scope.org_id) as Row[];
  for (const r of orgRows) env[r.name] = decrypt(r.encrypted_value);

  // Tier 2 — project-level. Overrides org-level on name collision.
  const projectRows = db.prepare(`
    SELECT name, encrypted_value FROM env_vars
    WHERE org_id = ? AND project_id = ?
  `).all(scope.org_id, scope.project_id) as Row[];
  for (const r of projectRows) env[r.name] = decrypt(r.encrypted_value);

  // Tier 3 — job-linked explicit attachments. Highest precedence: overrides
  // both org- and project-level on name collision.
  const linkedRows = db.prepare(`
    SELECT ev.name, ev.encrypted_value
    FROM job_env_vars jev
    JOIN env_vars ev ON jev.env_var_id = ev.id
    WHERE jev.job_id = ?
  `).all(jobId) as Row[];
  for (const r of linkedRows) env[r.name] = decrypt(r.encrypted_value);

  return env;
}
