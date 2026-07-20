import { v4 as uuid } from "uuid";
import { decrypt, encrypt } from "../encryption";
import { getDb } from "./schema";

/**
 * Enforce env-var name uniqueness per project in the query layer (the schema
 * deliberately has no UNIQUE constraint). Throws on collision.
 */
function assertNameAvailable(projectId: string, name: string, excludeId?: string) {
  const db = getDb();
  const params: any[] = [projectId, name];
  let sql = `SELECT id FROM env_vars WHERE project_id = ? AND name = ?`;
  if (excludeId) {
    sql += ` AND id != ?`;
    params.push(excludeId);
  }
  const existing = db.prepare(sql).get(...params) as { id: string } | undefined;
  if (existing) {
    throw new Error(`An env var named "${name}" already exists in this project`);
  }
}

export function createEnvVar(projectId: string, name: string, value: string) {
  const db = getDb();
  assertNameAvailable(projectId, name);
  const id = uuid();
  const encrypted = encrypt(value);
  db.prepare(
    `INSERT INTO env_vars (id, project_id, name, encrypted_value) VALUES (?, ?, ?, ?)`,
  ).run(id, projectId, name, encrypted);
  return getEnvVarById(id);
}

export function getEnvVarById(id: string) {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT id, project_id, name, pinned, created_at, updated_at FROM env_vars WHERE id = ?`,
      )
      .get(id) as any) || null
  );
}

/** List env vars — one project's when projectId is given, all projects' otherwise. */
export function listEnvVars(projectId?: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT ev.id, ev.project_id, p.name as project_name, ev.name, ev.pinned, ev.created_at, ev.updated_at
    FROM env_vars ev
    JOIN projects p ON ev.project_id = p.id
    ${projectId ? "WHERE ev.project_id = ?" : ""}
    ORDER BY ev.pinned DESC, ev.name ASC
  `)
    .all(...(projectId ? [projectId] : []));
}

export function updateEnvVar(id: string, data: { name?: string; value?: string }) {
  const db = getDb();
  if (data.name !== undefined) {
    const current = db.prepare(`SELECT project_id FROM env_vars WHERE id = ?`).get(id) as
      | { project_id: string }
      | undefined;
    if (current) assertNameAvailable(current.project_id, data.name, id);
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

// Link/unlink env vars to jobs
export function linkEnvVarToJob(jobId: string, envVarId: string) {
  const db = getDb();
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
 * Decrypt the env vars injected into a job's run payload (used by
 * buildRunPayload / the runner claim payload): pinned vars from the job's own
 * project first, then vars explicitly linked via `job_env_vars` (any project)
 * in link-creation order — on a name collision the later assignment wins.
 *
 * Returns the decrypted name→value map. (Values stay in the payload; the runner
 * delivers them as real process env vars and lists names-only in the prompt.)
 */
export function getDecryptedEnvVarsForJob(jobId: string): Record<string, string> {
  const db = getDb();
  type Row = { name: string; encrypted_value: string };

  const pinned = db
    .prepare(`
    SELECT name, encrypted_value FROM env_vars
    WHERE pinned = 1 AND project_id = (SELECT project_id FROM jobs WHERE id = ?)
  `)
    .all(jobId) as Row[];
  const linked = db
    .prepare(`
    SELECT ev.name, ev.encrypted_value
    FROM job_env_vars jev
    JOIN env_vars ev ON jev.env_var_id = ev.id
    WHERE jev.job_id = ?
    ORDER BY jev.rowid ASC
  `)
    .all(jobId) as Row[];

  const env: Record<string, string> = {};
  for (const r of [...pinned, ...linked]) env[r.name] = decrypt(r.encrypted_value);
  return env;
}
