import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import { hashSync, compareSync } from "bcryptjs";

// ─── Users ───────────────────────────────────────────────────────────────────

/**
 * Create a user. In v2, an admin may create a user with no password yet
 * (password_hash stays NULL until a set-password link is consumed — that flow
 * lands in Phase 2). Passing a password hashes it immediately.
 */
export function createUser(
  email: string,
  password: string | null,
  displayName: string,
  opts: { isInstanceAdmin?: boolean } = {}
) {
  const db = getDb();
  const id = uuid();
  const passwordHash = password === null ? null : hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, is_instance_admin) VALUES (?, ?, ?, ?, ?)`
  ).run(id, email, passwordHash, displayName, opts.isInstanceAdmin ? 1 : 0);
  return getUserById(id);
}

export function authenticateUser(email: string, password: string) {
  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as any;
  if (!user) return null;
  // A null password_hash means the set-password link hasn't been consumed yet —
  // the account can't log in with a password.
  if (!user.password_hash) return null;
  if (!compareSync(password, user.password_hash)) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_instance_admin: !!user.is_instance_admin,
  };
}

export function setUserPassword(id: string, password: string) {
  const db = getDb();
  const passwordHash = hashSync(password, 10);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?`).run(passwordHash, id);
  return getUserById(id);
}

export function getUserById(id: string) {
  const db = getDb();
  const user = db.prepare(
    `SELECT id, email, display_name, is_instance_admin, created_at, updated_at FROM users WHERE id = ?`
  ).get(id) as any;
  return user || null;
}

export function getUserByEmail(email: string) {
  const db = getDb();
  const user = db.prepare(
    `SELECT id, email, display_name, is_instance_admin, created_at, updated_at FROM users WHERE email = ?`
  ).get(email) as any;
  return user || null;
}

export function listUsers() {
  const db = getDb();
  return db.prepare(
    `SELECT id, email, display_name, is_instance_admin, created_at FROM users ORDER BY email`
  ).all();
}

export function updateUser(id: string, data: { displayName?: string; isInstanceAdmin?: boolean }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.displayName !== undefined) { fields.push("display_name = ?"); values.push(data.displayName); }
  if (data.isInstanceAdmin !== undefined) { fields.push("is_instance_admin = ?"); values.push(data.isInstanceAdmin ? 1 : 0); }
  if (fields.length === 0) return getUserById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getUserById(id);
}

export function deleteUser(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export function createSession(userId: string): string {
  const db = getDb();
  const id = uuid();
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(id, userId, expiresAt);
  return id;
}

export function getSession(sessionId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    `SELECT s.*, u.id as uid, u.email, u.display_name, u.is_instance_admin
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > ?`
  ).get(sessionId, now) as any;
  if (!session) return null;
  return {
    sessionId: session.id,
    userId: session.uid,
    email: session.email,
    displayName: session.display_name,
    isInstanceAdmin: !!session.is_instance_admin,
  };
}

export function deleteSession(sessionId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}
