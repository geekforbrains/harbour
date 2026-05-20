import { getDb } from "./schema";

export type WorkspaceInput = {
  name: string;
  slug?: string;
  kind?: string;
  root_path?: string | null;
  description?: string | null;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  root_path: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
};

export class WorkspaceConflictError extends Error {
  constructor(slug: string) {
    super(`Workspace already exists: ${slug}`);
    this.name = "WorkspaceConflictError";
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createWorkspace(data: WorkspaceInput): WorkspaceRecord | null {
  const db = getDb();
  const slug = data.slug?.trim() || slugify(data.name);
  const id = slug;
  if (getWorkspaceById(id)) {
    throw new WorkspaceConflictError(slug);
  }
  db.prepare(`
    INSERT INTO workspaces (id, name, slug, kind, root_path, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, data.name.trim(), slug, data.kind || "workspace", data.root_path || null, data.description || null);
  return getWorkspaceById(id);
}

export function getWorkspaceById(id: string): WorkspaceRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as WorkspaceRecord | undefined;
  return row || null;
}

export function listWorkspaces(): WorkspaceRecord[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM workspaces ORDER BY name ASC`).all() as WorkspaceRecord[];
}

export function updateWorkspace(id: string, data: Partial<WorkspaceInput>): WorkspaceRecord | null {
  const db = getDb();
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name.trim()); }
  if (data.slug !== undefined) { fields.push("slug = ?"); values.push(data.slug.trim()); }
  if (data.kind !== undefined) { fields.push("kind = ?"); values.push(data.kind); }
  if (data.root_path !== undefined) { fields.push("root_path = ?"); values.push(data.root_path); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description); }
  if (fields.length === 0) return getWorkspaceById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getWorkspaceById(id);
}

export function deleteWorkspace(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
}
