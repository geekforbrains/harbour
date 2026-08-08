import { randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";
import { hashToken } from "./tokens";
import { deleteUserSessions, setUserPassword } from "./users";

// ─── Set-password / reset tokens ──────────────────────────────────────────────
//
// New-user setup and password reset are the same mechanism: a user mints a
// single-use token for another user, hands the raw token to them out of band,
// and the user redeems it to set their own password. Only the SHA-256 hash of
// the token is stored; the raw value never touches the database.

const TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h

export type SetPasswordToken = {
  id: string;
  token_hash: string;
  user_id: string;
  created_by_user_id: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

/**
 * Mint a single-use set-password token for a user. Returns the raw token (to be
 * embedded in a link and handed over out of band) plus its db row metadata. The
 * raw token is intentionally not persisted — only its SHA-256 hash is stored.
 */
export function createSetPasswordToken(
  userId: string,
  createdByUserId: string | null,
): { rawToken: string; id: string; expiresAt: number } {
  const db = getDb();
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const id = uuid();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  db.prepare(
    `INSERT INTO set_password_tokens (id, token_hash, user_id, created_by_user_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, tokenHash, userId, createdByUserId, expiresAt);
  return { rawToken, id, expiresAt };
}

/** Look up a token row by its raw value, or null if unknown. */
export function getSetPasswordToken(rawToken: string): SetPasswordToken | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM set_password_tokens WHERE token_hash = ?`)
    .get(hashToken(rawToken)) as SetPasswordToken | undefined;
  return row || null;
}

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "not_found" | "expired" | "consumed" };

/**
 * Atomically redeem a set-password token: validate it's known, unexpired, and
 * unconsumed, mark it consumed, and set the target user's password — all in one
 * transaction so a token can never be spent twice. Returns the affected user id
 * on success.
 */
export function consumeSetPasswordToken(rawToken: string, newPassword: string): ConsumeResult {
  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction((): ConsumeResult => {
    const row = db
      .prepare(`SELECT * FROM set_password_tokens WHERE token_hash = ?`)
      .get(tokenHash) as SetPasswordToken | undefined;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.consumed_at !== null) return { ok: false, reason: "consumed" };
    if (row.expires_at <= now) return { ok: false, reason: "expired" };

    // Mark consumed first (guarded by the consumed_at IS NULL predicate so a
    // concurrent transaction can't double-spend even outside this serialized txn).
    const res = db
      .prepare(
        `UPDATE set_password_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(now, row.id);
    if (res.changes !== 1) return { ok: false, reason: "consumed" };

    setUserPassword(row.user_id, newPassword);
    // A reset is the remedy for a compromised account, so every session opened
    // under the old password dies with it — otherwise a stolen cookie stays
    // valid for the rest of its TTL (30 days by default). The caller mints a
    // fresh session afterwards, so the user redeeming the token stays logged in.
    deleteUserSessions(row.user_id);
    return { ok: true, userId: row.user_id };
  });

  return txn();
}

/** Delete all expired or consumed tokens. Housekeeping; safe to call anytime. */
export function pruneSetPasswordTokens(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `DELETE FROM set_password_tokens WHERE consumed_at IS NOT NULL OR expires_at <= ?`,
  ).run(now);
}
