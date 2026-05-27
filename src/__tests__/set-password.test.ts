import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import {
  createUser,
  authenticateUser,
  hashPassword,
  verifyPassword,
  createSetPasswordToken,
  getSetPasswordToken,
  consumeSetPasswordToken,
  pruneSetPasswordTokens,
} from "@/lib/db/queries";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  const db = freshDb();
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
  vi.useRealTimers();
});

// ===========================================================================
// argon2id hashing
// ===========================================================================

describe("argon2id password hashing", () => {
  it("hashes to a self-describing argon2id PHC string and verifies round-trip", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("produces distinct hashes for the same password (random salt)", () => {
    const a = hashPassword("samepass");
    const b = hashPassword("samepass");
    expect(a).not.toBe(b);
    expect(verifyPassword(a, "samepass")).toBe(true);
    expect(verifyPassword(b, "samepass")).toBe(true);
  });

  it("returns false rather than throwing on a malformed hash", () => {
    expect(verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("createUser stores an argon2id hash; authenticateUser verifies it", () => {
    createUser("a@example.com", "hunter2pw", "Alice");
    expect(authenticateUser("a@example.com", "hunter2pw")).not.toBeNull();
    expect(authenticateUser("a@example.com", "nope")).toBeNull();
  });

  it("authenticateUser rejects users with a null password_hash", () => {
    createUser("b@example.com", null, "Bob");
    expect(authenticateUser("b@example.com", "anything")).toBeNull();
  });
});

// ===========================================================================
// set_password_tokens
// ===========================================================================

describe("set_password_tokens", () => {
  function makeUser(email = "u@example.com") {
    const u = createUser(email, null, "User") as { id: string };
    return u.id;
  }

  it("creates a token, stores only its hash, and looks it up by raw value", () => {
    const userId = makeUser();
    const { rawToken, id } = createSetPasswordToken(userId, null);
    expect(rawToken).toBeTruthy();

    // Raw token is not stored in plaintext.
    const stored = getDb()
      .prepare(`SELECT token_hash FROM set_password_tokens WHERE id = ?`)
      .get(id) as { token_hash: string };
    expect(stored.token_hash).not.toBe(rawToken);

    const row = getSetPasswordToken(rawToken);
    expect(row?.user_id).toBe(userId);
    expect(row?.consumed_at).toBeNull();
  });

  it("consumes a valid token: sets the password and marks it consumed", () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    const res = consumeSetPasswordToken(rawToken, "brandnewpass");
    expect(res).toEqual({ ok: true, userId });

    // Password is now set and authenticates.
    expect(authenticateUser("u@example.com", "brandnewpass")).not.toBeNull();

    // Token is marked consumed.
    const row = getSetPasswordToken(rawToken);
    expect(row?.consumed_at).not.toBeNull();
  });

  it("rejects an unknown token", () => {
    const res = consumeSetPasswordToken("does-not-exist", "whatever");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("is single-use: a second consume fails and does not change the password", () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    expect(consumeSetPasswordToken(rawToken, "firstpass").ok).toBe(true);

    const second = consumeSetPasswordToken(rawToken, "secondpass");
    expect(second).toEqual({ ok: false, reason: "consumed" });

    // Still the first password.
    expect(authenticateUser("u@example.com", "firstpass")).not.toBeNull();
    expect(authenticateUser("u@example.com", "secondpass")).toBeNull();
  });

  it("rejects an expired token", () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    // Force the token's expiry into the past.
    getDb()
      .prepare(
        `UPDATE set_password_tokens SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM set_password_tokens LIMIT 1)`
      )
      .run(Math.floor(Date.now() / 1000) - 10);

    const res = consumeSetPasswordToken(rawToken, "tooLate12");
    expect(res).toEqual({ ok: false, reason: "expired" });
    // No password was set.
    expect(authenticateUser("u@example.com", "tooLate12")).toBeNull();
  });

  it("consume is atomic: the password write and the consumed flag commit together", () => {
    const userId = makeUser();
    const { rawToken, id } = createSetPasswordToken(userId, null);

    const res = consumeSetPasswordToken(rawToken, "atomicpass");
    expect(res.ok).toBe(true);

    const row = getDb()
      .prepare(`SELECT consumed_at FROM set_password_tokens WHERE id = ?`)
      .get(id) as { consumed_at: number | null };
    const user = getDb()
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(userId) as { password_hash: string | null };

    // Both sides of the transaction are present (or neither would be).
    expect(row.consumed_at).not.toBeNull();
    expect(user.password_hash).not.toBeNull();
  });

  it("prune removes consumed and expired tokens but keeps live ones", () => {
    const userId = makeUser();
    const live = createSetPasswordToken(userId, null);
    const toExpire = createSetPasswordToken(userId, null);
    const toConsume = createSetPasswordToken(userId, null);

    consumeSetPasswordToken(toConsume.rawToken, "consumedpw");
    getDb()
      .prepare(`UPDATE set_password_tokens SET expires_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 1, toExpire.id);

    pruneSetPasswordTokens();

    expect(getSetPasswordToken(live.rawToken)).not.toBeNull();
    expect(getSetPasswordToken(toExpire.rawToken)).toBeNull();
    expect(getSetPasswordToken(toConsume.rawToken)).toBeNull();
  });
});
