import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import { createUser, createSession, sessionTtlDays } from "@/lib/db/queries";

describe("sessionTtlDays", () => {
  it("defaults to 30 when unset", () => {
    expect(sessionTtlDays(undefined)).toBe(30);
  });

  it("uses a valid override", () => {
    expect(sessionTtlDays("7")).toBe(7);
    expect(sessionTtlDays("0.5")).toBe(0.5);
    expect(sessionTtlDays("90")).toBe(90);
  });

  it("falls back to 30 on garbage input", () => {
    expect(sessionTtlDays("abc")).toBe(30);
    expect(sessionTtlDays("")).toBe(30);
    expect(sessionTtlDays("-5")).toBe(30);
    expect(sessionTtlDays("0")).toBe(30);
    expect(sessionTtlDays("Infinity")).toBe(30);
    expect(sessionTtlDays("NaN")).toBe(30);
  });
});

describe("createSession TTL", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    setDb(db);
    initializeSchema(db);
  });

  afterEach(() => {
    resetDb();
    vi.unstubAllEnvs();
  });

  function sessionExpiresAt(sessionId: string): number {
    const row = getDb()
      .prepare(`SELECT expires_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { expires_at: number };
    return row.expires_at;
  }

  it("defaults to 30 days", () => {
    vi.stubEnv("HARBOUR_SESSION_TTL_DAYS", "");
    const user = createUser("u@example.com", "longenoughpass", "U") as { id: string };
    const sessionId = createSession(user.id);
    const expected = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    expect(sessionExpiresAt(sessionId)).toBeGreaterThanOrEqual(expected - 5);
    expect(sessionExpiresAt(sessionId)).toBeLessThanOrEqual(expected + 5);
  });

  it("respects HARBOUR_SESSION_TTL_DAYS", () => {
    vi.stubEnv("HARBOUR_SESSION_TTL_DAYS", "1");
    const user = createUser("u@example.com", "longenoughpass", "U") as { id: string };
    const sessionId = createSession(user.id);
    const expected = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    expect(sessionExpiresAt(sessionId)).toBeGreaterThanOrEqual(expected - 5);
    expect(sessionExpiresAt(sessionId)).toBeLessThanOrEqual(expected + 5);
  });
});
