import { getDb } from "./schema";

// ── Roles ──────────────────────────────────────────────────────────────────

export type Role = "instance_admin" | "editor" | "viewer";

/**
 * Numeric rank so a route can express a minimum role and `meets()` checks it.
 * instance_admin always satisfies any minimum.
 */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  instance_admin: 3,
};

/** Does `role` satisfy the `min` requirement? instance_admin satisfies all. */
export function meets(role: Role | null, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// ── Access resolution ────────────────────────────────────────────────────

/**
 * Resolve a user's effective role within an org.
 *
 * - instance admins resolve to 'instance_admin' everywhere (no membership row)
 * - otherwise the role comes from the membership for (user, org)
 * - non-members (and unknown users) resolve to null
 */
export function resolveAccess(userId: string, orgId: string): Role | null {
  const db = getDb();

  const user = db.prepare(`SELECT is_instance_admin FROM users WHERE id = ?`).get(userId) as
    | { is_instance_admin: number }
    | undefined;
  if (!user) return null;
  if (user.is_instance_admin) return "instance_admin";

  const membership = db
    .prepare(`SELECT role FROM memberships WHERE user_id = ? AND org_id = ?`)
    .get(userId, orgId) as { role: "editor" | "viewer" } | undefined;
  return membership?.role ?? null;
}

// ── Hierarchy: resolve an entity to its owning org ─────────────────────────

export function orgIdForProject(id: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(id) as
    | { org_id: string }
    | undefined;
  return row?.org_id ?? null;
}

export function orgIdForAgent(id: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.org_id AS org_id
       FROM agents a JOIN projects p ON a.project_id = p.id
       WHERE a.id = ?`,
    )
    .get(id) as { org_id: string } | undefined;
  return row?.org_id ?? null;
}

export function orgIdForJob(id: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.org_id AS org_id
       FROM jobs j JOIN projects p ON j.project_id = p.id
       WHERE j.id = ?`,
    )
    .get(id) as { org_id: string } | undefined;
  return row?.org_id ?? null;
}

export function orgIdForRun(id: string): string | null {
  const db = getDb();
  // runs.project_id is denormalized, so a single join suffices.
  const row = db
    .prepare(
      `SELECT p.org_id AS org_id
       FROM runs r JOIN projects p ON r.project_id = p.id
       WHERE r.id = ?`,
    )
    .get(id) as { org_id: string } | undefined;
  return row?.org_id ?? null;
}

export type ResourceKind = "project" | "agent" | "job" | "run" | "doc" | "env_var" | "database";

/**
 * Resolve any resource (by kind + id) to its owning org id, walking the
 * hierarchy as needed. Returns null when the resource doesn't exist.
 */
export function orgIdForResource(kind: ResourceKind, id: string): string | null {
  const db = getDb();
  switch (kind) {
    case "project":
      return orgIdForProject(id);
    case "agent":
      return orgIdForAgent(id);
    case "job":
      return orgIdForJob(id);
    case "run":
      return orgIdForRun(id);
    case "doc": {
      const row = db.prepare(`SELECT org_id FROM docs WHERE id = ?`).get(id) as
        | { org_id: string }
        | undefined;
      return row?.org_id ?? null;
    }
    case "env_var": {
      const row = db.prepare(`SELECT org_id FROM env_vars WHERE id = ?`).get(id) as
        | { org_id: string }
        | undefined;
      return row?.org_id ?? null;
    }
    case "database": {
      const row = db.prepare(`SELECT org_id FROM databases WHERE id = ?`).get(id) as
        | { org_id: string }
        | undefined;
      return row?.org_id ?? null;
    }
    default:
      return null;
  }
}
