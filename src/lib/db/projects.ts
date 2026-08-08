import { v4 as uuid } from "uuid";
import { InvalidNameError, NameCollisionError, slugify } from "../slug";
import { deleteRunAttachmentsDir } from "./attachments";
import { getDb, isUniqueViolation } from "./schema";
import { deleteTable } from "./tables";

function projectCollisionError(existingName: string, slug: string) {
  return new NameCollisionError(
    `A project named "${existingName}" already exists (folder name "${slug}") — ` +
      `names must be unique ignoring case and punctuation.`,
  );
}

export function createProject(name: string) {
  const db = getDb();
  const slug = slugify(name);
  if (!slug) {
    throw new InvalidNameError("Project name must contain at least one letter or number.");
  }
  // Slugs are unique instance-wide (the project's workspace directory name).
  const existing = db.prepare(`SELECT name FROM projects WHERE slug = ?`).get(slug) as
    | { name: string }
    | undefined;
  if (existing) throw projectCollisionError(existing.name, slug);
  const id = uuid();
  try {
    db.prepare(`INSERT INTO projects (id, name, slug) VALUES (?, ?, ?)`).run(id, name, slug);
  } catch (err) {
    // Race backstop: a concurrent create can slip past the pre-check; the
    // unique index catches it.
    if (isUniqueViolation(err)) {
      const winner = db.prepare(`SELECT name FROM projects WHERE slug = ?`).get(slug) as
        | { name: string }
        | undefined;
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

export function listProjects() {
  const db = getDb();
  return db.prepare(`SELECT * FROM projects ORDER BY name ASC`).all();
}

export function updateProject(id: string, data: { name?: string }) {
  const db = getDb();
  if (data.name === undefined) return getProjectById(id);
  // Rename never touches the slug — workspace paths stay stable.
  db.prepare(`UPDATE projects SET name = ?, updated_at = unixepoch() WHERE id = ?`).run(
    data.name,
    id,
  );
  return getProjectById(id);
}

/**
 * ON DELETE CASCADE wipes the rows beneath the project (agents, jobs, runs,
 * docs, env vars, tables), but two things live outside the FK graph and have to
 * go by hand — the same cleanup deleteAgent/deleteJob already do:
 *   - the physical `t_*` SQLite tables holding agent-written data, which would
 *     otherwise stay in the DB file unreachable from listTables;
 *   - the uploads/runs/<id>/ attachment dirs on disk.
 * Both are collected before the delete, since cascade removes the rows that
 * point at them.
 */
export function deleteProject(id: string) {
  const db = getDb();
  const tableIds = db.prepare(`SELECT id FROM tables WHERE project_id = ?`).all(id) as {
    id: string;
  }[];
  const runIds = db.prepare(`SELECT id FROM runs WHERE project_id = ?`).all(id) as { id: string }[];

  // deleteTable drops the physical table and its metadata row together; doing
  // it before the cascade keeps the two in step even if one throws.
  for (const t of tableIds) deleteTable(t.id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  for (const r of runIds) deleteRunAttachmentsDir(r.id);
}
