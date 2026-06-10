import { type Algorithm, hashSync, verifySync } from "@node-rs/argon2";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

// @node-rs/argon2 exports Algorithm as a `const enum`, which can't be referenced
// as a value under isolatedModules. Argon2id is the numeric value 2; pin it with
// the type so the options object stays correctly typed.
const ARGON2ID: Algorithm = 2 as Algorithm;

// ─── Password hashing (argon2id) ──────────────────────────────────────────────

/**
 * argon2id parameters. These are the encoded-string output's defaults from
 * @node-rs/argon2 (m=19456 KiB, t=2, p=1) — a sensible interactive-login cost.
 * We use the synchronous, self-describing PHC-string API so a stored hash
 * carries its own parameters and the CLI bootstrap (which hashes the first
 * instance admin) stays byte-compatible with this verifier.
 */
const ARGON2_OPTS = { algorithm: ARGON2ID } as const;

/** Hash a plaintext password into a self-describing argon2id PHC string. */
export function hashPassword(password: string): string {
  return hashSync(password, ARGON2_OPTS);
}

/** Verify a plaintext password against a stored argon2id PHC string. */
export function verifyPassword(hash: string, password: string): boolean {
  try {
    return verifySync(hash, password, ARGON2_OPTS);
  } catch {
    return false;
  }
}

// ─── Users ───────────────────────────────────────────────────────────────────

/**
 * Create a user. In v2, an admin may create a user with no password yet
 * (password_hash stays NULL until a set-password link is consumed). Passing a
 * password hashes it immediately with argon2id.
 */
export function createUser(
  email: string,
  password: string | null,
  displayName: string,
  opts: { isInstanceAdmin?: boolean } = {},
) {
  const db = getDb();
  const id = uuid();
  const passwordHash = password === null ? null : hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, is_instance_admin) VALUES (?, ?, ?, ?, ?)`,
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
  if (!verifySync(user.password_hash, password)) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_instance_admin: !!user.is_instance_admin,
  };
}

export function setUserPassword(id: string, password: string) {
  const db = getDb();
  const passwordHash = hashSync(password);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?`).run(
    passwordHash,
    id,
  );
  return getUserById(id);
}

export function getUserById(id: string) {
  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, email, display_name, is_instance_admin, created_at, updated_at FROM users WHERE id = ?`,
    )
    .get(id) as any;
  return user || null;
}

export function getUserByEmail(email: string) {
  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, email, display_name, is_instance_admin, created_at, updated_at FROM users WHERE email = ?`,
    )
    .get(email) as any;
  return user || null;
}

export function listUsers() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, email, display_name, is_instance_admin, created_at FROM users ORDER BY email`,
    )
    .all();
}

export function updateUser(id: string, data: { displayName?: string; isInstanceAdmin?: boolean }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.displayName !== undefined) {
    fields.push("display_name = ?");
    values.push(data.displayName);
  }
  if (data.isInstanceAdmin !== undefined) {
    fields.push("is_instance_admin = ?");
    values.push(data.isInstanceAdmin ? 1 : 0);
  }
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

const DEFAULT_SESSION_TTL_DAYS = 30;

/**
 * Session lifetime in days, from HARBOUR_SESSION_TTL_DAYS. Anything that isn't
 * a positive finite number falls back to the 30-day default.
 */
export function sessionTtlDays(
  raw: string | undefined = process.env.HARBOUR_SESSION_TTL_DAYS,
): number {
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_SESSION_TTL_DAYS;
}

/** Session lifetime in seconds — for DB expiry and the cookie's maxAge. */
export function sessionTtlSeconds(): number {
  return Math.floor(sessionTtlDays() * 24 * 60 * 60);
}

export function createSession(userId: string): string {
  const db = getDb();
  const id = uuid();
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(
    id,
    userId,
    expiresAt,
  );
  return id;
}

export function getSession(sessionId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const session = db
    .prepare(
      `SELECT s.*, u.id as uid, u.email, u.display_name, u.is_instance_admin
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, now) as any;
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
