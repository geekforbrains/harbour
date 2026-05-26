import { getDb } from "./schema";
import { v4 as uuid } from "uuid";

// --- Org-scoped project CRUD ---

export function createProject(orgId: string, name: string) {
  const db = getDb();
  const id = uuid();
  db.prepare(`INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?)`).run(id, orgId, name);
  return getProjectById(id);
}

export function getProjectById(id: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as any || null;
}

/**
 * List projects for an org. By default only active (non-archived) projects are
 * returned; pass includeArchived to include soft-deleted ones.
 */
export function listProjects(orgId: string, opts: { includeArchived?: boolean } = {}) {
  const db = getDb();
  const archivedFilter = opts.includeArchived ? "" : "AND archived_at IS NULL";
  return db.prepare(
    `SELECT * FROM projects WHERE org_id = ? ${archivedFilter} ORDER BY name ASC`
  ).all(orgId);
}

export function updateProject(id: string, data: { name?: string }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (fields.length === 0) return getProjectById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

/** Soft-delete: mark archived. Data is preserved and the project is hidden. */
export function archiveProject(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`
  ).run(id);
  return getProjectById(id);
}

/** Restore a soft-deleted project. */
export function unarchiveProject(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET archived_at = NULL, updated_at = unixepoch() WHERE id = ?`
  ).run(id);
  return getProjectById(id);
}

/**
 * Hard delete: admin escape hatch. ON DELETE CASCADE wipes everything beneath
 * the project (agents, jobs, runs, project-level resources).
 */
export function deleteProject(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}
