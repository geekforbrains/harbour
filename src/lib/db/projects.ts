import { v4 as uuid } from "uuid";
import { InvalidNameError, NameCollisionError, slugify } from "../slug";
import { getDb, isUniqueViolation } from "./schema";

// --- Org-scoped project CRUD ---

function projectCollisionError(existingName: string, slug: string) {
  return new NameCollisionError(
    `A project named "${existingName}" already exists in this organization ` +
      `(folder name "${slug}") — names must be unique ignoring case and punctuation.`,
  );
}

export function createProject(orgId: string, name: string) {
  const db = getDb();
  const slug = slugify(name);
  if (!slug) {
    throw new InvalidNameError("Project name must contain at least one letter or number.");
  }
  // Slugs are unique per org, archived projects included — an archived project
  // keeps its slug so a new same-name project can't inherit its leftover
  // workspace directories on runner machines.
  const existing = db
    .prepare(`SELECT name FROM projects WHERE org_id = ? AND slug = ?`)
    .get(orgId, slug) as { name: string } | undefined;
  if (existing) throw projectCollisionError(existing.name, slug);
  const id = uuid();
  try {
    db.prepare(`INSERT INTO projects (id, org_id, name, slug) VALUES (?, ?, ?, ?)`).run(
      id,
      orgId,
      name,
      slug,
    );
  } catch (err) {
    // Race backstop: a concurrent create can slip past the pre-check; the
    // unique index catches it.
    if (isUniqueViolation(err)) {
      const winner = db
        .prepare(`SELECT name FROM projects WHERE org_id = ? AND slug = ?`)
        .get(orgId, slug) as { name: string } | undefined;
      throw projectCollisionError(winner?.name ?? name, slug);
    }
    throw err;
  }
  return getProjectById(id);
}

export function getProjectById(id: string) {
  const db = getDb();
  return (db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as any) || null;
}

/**
 * List projects for an org. By default only active (non-archived) projects are
 * returned; pass includeArchived to include soft-deleted ones.
 */
export function listProjects(orgId: string, opts: { includeArchived?: boolean } = {}) {
  const db = getDb();
  const archivedFilter = opts.includeArchived ? "" : "AND archived_at IS NULL";
  return db
    .prepare(`SELECT * FROM projects WHERE org_id = ? ${archivedFilter} ORDER BY name ASC`)
    .all(orgId);
}

export function updateProject(id: string, data: { name?: string }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) {
    // Rename never touches the slug — workspace paths stay stable.
    fields.push("name = ?");
    values.push(data.name);
  }
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
    `UPDATE projects SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
  ).run(id);
  return getProjectById(id);
}

/** Restore a soft-deleted project. */
export function unarchiveProject(id: string) {
  const db = getDb();
  db.prepare(`UPDATE projects SET archived_at = NULL, updated_at = unixepoch() WHERE id = ?`).run(
    id,
  );
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
