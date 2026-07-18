import { v4 as uuid } from "uuid";
import { InvalidNameError, NameCollisionError, slugify } from "../slug";
import { getDb, isUniqueViolation } from "./schema";

// --- Org CRUD ---

function orgCollisionError(existingName: string, slug: string) {
  return new NameCollisionError(
    `An organization named "${existingName}" already exists (folder name "${slug}") — ` +
      `names must be unique ignoring case and punctuation.`,
  );
}

export function createOrg(name: string, settings?: Record<string, unknown>) {
  const db = getDb();
  const slug = slugify(name);
  if (!slug) {
    throw new InvalidNameError("Organization name must contain at least one letter or number.");
  }
  // Slugs are unique instance-wide, archived orgs included — an archived org
  // keeps its slug so a new same-name org can't inherit its leftover workspace
  // directories on runner machines.
  const existing = db.prepare(`SELECT name FROM orgs WHERE slug = ?`).get(slug) as
    | { name: string }
    | undefined;
  if (existing) throw orgCollisionError(existing.name, slug);
  const id = uuid();
  try {
    db.prepare(`INSERT INTO orgs (id, name, slug, settings) VALUES (?, ?, ?, ?)`).run(
      id,
      name,
      slug,
      JSON.stringify(settings ?? {}),
    );
  } catch (err) {
    // Race backstop: a concurrent create can slip past the pre-check; the
    // unique index catches it.
    if (isUniqueViolation(err)) {
      const winner = db.prepare(`SELECT name FROM orgs WHERE slug = ?`).get(slug) as
        | { name: string }
        | undefined;
      throw orgCollisionError(winner?.name ?? name, slug);
    }
    throw err;
  }
  return getOrgById(id);
}

export function getOrgById(id: string) {
  const db = getDb();
  return (db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(id) as any) || null;
}

/**
 * List orgs. By default only active (non-archived) orgs are returned; pass
 * includeArchived to include soft-deleted ones.
 */
export function listOrgs(opts: { includeArchived?: boolean } = {}) {
  const db = getDb();
  const archivedFilter = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
  return db.prepare(`SELECT * FROM orgs ${archivedFilter} ORDER BY name ASC`).all();
}

/** Orgs a user has access to via membership (instance admins see all elsewhere). */
export function listOrgsForUser(userId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT o.*, m.role AS member_role
     FROM orgs o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.user_id = ? AND o.archived_at IS NULL
     ORDER BY o.name ASC`,
    )
    .all(userId);
}

export function updateOrg(id: string, data: { name?: string; settings?: Record<string, unknown> }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) {
    // Rename never touches the slug — workspace paths stay stable.
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.settings !== undefined) {
    fields.push("settings = ?");
    values.push(JSON.stringify(data.settings));
  }
  if (fields.length === 0) return getOrgById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE orgs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getOrgById(id);
}

export function getOrgSettings(id: string): Record<string, unknown> {
  const org = getOrgById(id);
  if (!org) return {};
  try {
    return JSON.parse(org.settings || "{}");
  } catch {
    return {};
  }
}

/** Soft-delete: mark archived. Data is preserved and the org is hidden. */
export function archiveOrg(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE orgs SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
  ).run(id);
  return getOrgById(id);
}

/** Restore a soft-deleted org. */
export function unarchiveOrg(id: string) {
  const db = getDb();
  db.prepare(`UPDATE orgs SET archived_at = NULL, updated_at = unixepoch() WHERE id = ?`).run(id);
  return getOrgById(id);
}

/**
 * Hard delete: admin escape hatch. ON DELETE CASCADE wipes everything beneath
 * the org (projects, agents, jobs, runs, resources, memberships).
 */
export function deleteOrg(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM orgs WHERE id = ?`).run(id);
}

// --- Memberships ---

export function addMembership(userId: string, orgId: string, role: "editor" | "viewer") {
  const db = getDb();
  db.prepare(
    `INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)
     ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role`,
  ).run(userId, orgId, role);
}

export function removeMembership(userId: string, orgId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM memberships WHERE user_id = ? AND org_id = ?`).run(userId, orgId);
}

export function listMemberships(orgId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT m.user_id, m.role, u.email, u.display_name
     FROM memberships m JOIN users u ON m.user_id = u.id
     WHERE m.org_id = ?
     ORDER BY u.email ASC`,
    )
    .all(orgId);
}
