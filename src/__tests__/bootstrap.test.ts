import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "@/lib/db/tokens";
import { verifyPassword as serverVerify } from "@/lib/db/users";
import {
  hashPassword as cliHash,
  insertUser,
  provisionLocalRunner,
  userExists,
} from "../../bin/lib/bootstrap.mjs";
import { defaultServerUrl } from "../../bin/lib/server-config.mjs";

const CLI = path.resolve(__dirname, "../../bin/harbour.mjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

// Mirrors the users + runners DDL from src/lib/db/schema.ts — the same tables
// bootstrap.mjs creates on a fresh install (parity asserted below).
function memDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL CHECK(tier IN ('local','remote')),
      labels TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT,
      scope TEXT,
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

describe("CLI bootstrap helpers", () => {
  it("userExists flips once a user is inserted", () => {
    const db = memDb();
    expect(userExists(db)).toBe(false);
    insertUser(db, {
      email: "a@example.com",
      displayName: "A",
      password: "supersecret123",
    });
    expect(userExists(db)).toBe(true);
  });

  it("CLI-produced hashes verify with the server's argon2id verifier (parity)", () => {
    const hash = cliHash("supersecret123");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(serverVerify(hash, "supersecret123")).toBe(true);
    expect(serverVerify(hash, "wrong")).toBe(false);
  });

  it("provisionLocalRunner registers a local runner + writes the token, idempotently", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-prov-"));
    const prev = process.env.HARBOUR_HOME;
    process.env.HARBOUR_HOME = home;
    try {
      const db = memDb();
      const first = provisionLocalRunner(db, { url: defaultServerUrl({}) });
      expect(first.provisioned).toBe(true);

      // One local runner row exists, and its token was written (0600).
      const rows = db.prepare(`SELECT tier, token_hash FROM runners`).all() as {
        tier: string;
        token_hash: string;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].tier).toBe("local");
      const tokenPath = path.join(home, "runner.token");
      const token = fs.readFileSync(tokenPath, "utf-8").trim();
      expect(token).toMatch(/^hbrn_[0-9a-f]{64}$/);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      // The stored hash matches the written token (sha256).
      const sha = hashToken(token);
      expect(rows[0].token_hash).toBe(sha);
      expect(fs.readFileSync(path.join(home, "runner.url"), "utf-8").trim()).toBe(
        defaultServerUrl({}),
      );

      // Idempotent: a second call provisions nothing and adds no row.
      const second = provisionLocalRunner(db, { url: defaultServerUrl({}) });
      expect(second.provisioned).toBe(false);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM runners`).get() as { n: number }).n).toBe(1);
    } finally {
      process.env.HARBOUR_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rolls back the runner row when credentials cannot be written", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-prov-fail-"));
    const invalidHome = path.join(parent, "not-a-directory");
    fs.writeFileSync(invalidHome, "file");
    const prev = process.env.HARBOUR_HOME;
    process.env.HARBOUR_HOME = invalidHome;
    const db = memDb();
    try {
      expect(() => provisionLocalRunner(db, { url: defaultServerUrl({}) })).toThrow();
      expect((db.prepare(`SELECT COUNT(*) AS n FROM runners`).get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
      if (prev === undefined) delete process.env.HARBOUR_HOME;
      else process.env.HARBOUR_HOME = prev;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("CLI `harbour user create` (subprocess)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-boot-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, HARBOUR_HOME: home, ...extraEnv },
        encoding: "utf-8",
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("creates the first user and auto-provisions the local runner", () => {
    const r = run([
      "user",
      "create",
      "--email",
      "user@example.com",
      "--name",
      "User",
      "--password",
      "supersecret123",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("User created: user@example.com");
    expect(r.stdout).toContain("Local runner provisioned");
    // The runner token is on disk — a fresh install can run work immediately.
    expect(fs.readFileSync(path.join(home, "runner.token"), "utf-8").trim()).toMatch(/^hbrn_/);
    expect(fs.readFileSync(path.join(home, "runner.url"), "utf-8").trim()).toBe(
      defaultServerUrl(process.env),
    );
  });

  it("accepts the password from HARBOUR_USER_PASSWORD", () => {
    const r = run(["user", "create", "--email", "user@example.com", "--name", "User"], {
      HARBOUR_USER_PASSWORD: "supersecret123",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("User created: user@example.com");
  });

  it("persists an explicit runner URL during non-interactive setup", () => {
    const r = run(
      [
        "user",
        "create",
        "--email",
        "user@example.com",
        "--name",
        "User",
        "--password",
        "supersecret123",
      ],
      { HARBOUR_URL: "https://harbour.example/" },
    );
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home, "runner.url"), "utf-8").trim()).toBe(
      "https://harbour.example",
    );
  });

  it("persists the coordinated Harbour port during non-interactive setup", () => {
    const r = run(
      [
        "user",
        "create",
        "--email",
        "user@example.com",
        "--name",
        "User",
        "--password",
        "supersecret123",
      ],
      { HARBOUR_URL: "", HARBOUR_PORT: "18080" },
    );
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home, "runner.url"), "utf-8").trim()).toBe(
      "http://127.0.0.1:18080",
    );
  });

  it("rejects a password under 8 characters", () => {
    const r = run([
      "user",
      "create",
      "--email",
      "user@example.com",
      "--name",
      "User",
      "--password",
      "short12",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toContain("at least 8 characters");
  });

  it("refuses to create a second user without --force", () => {
    const first = run([
      "user",
      "create",
      "--email",
      "user@example.com",
      "--name",
      "User",
      "--password",
      "supersecret123",
    ]);
    expect(first.code).toBe(0);

    const second = run([
      "user",
      "create",
      "--email",
      "user2@example.com",
      "--name",
      "User2",
      "--password",
      "supersecret123",
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr + second.stdout).toContain("already exists");

    // --force overrides.
    const forced = run([
      "user",
      "create",
      "--email",
      "user2@example.com",
      "--name",
      "User2",
      "--password",
      "supersecret123",
      "--force",
    ]);
    expect(forced.code).toBe(0);
  });
});
