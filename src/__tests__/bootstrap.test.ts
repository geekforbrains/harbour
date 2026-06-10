import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword as serverVerify } from "@/lib/db/users";
import {
  hashPassword as cliHash,
  insertInstanceAdmin,
  instanceAdminExists,
} from "../../bin/lib/bootstrap.mjs";

const CLI = path.resolve(__dirname, "../../bin/harbour.mjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

function memDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT NOT NULL,
      is_instance_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

describe("CLI bootstrap helpers", () => {
  it("instanceAdminExists flips once an admin is inserted", () => {
    const db = memDb();
    expect(instanceAdminExists(db)).toBe(false);
    insertInstanceAdmin(db, {
      email: "a@example.com",
      displayName: "A",
      password: "supersecret123",
    });
    expect(instanceAdminExists(db)).toBe(true);
  });

  it("CLI-produced hashes verify with the server's argon2id verifier (parity)", () => {
    const hash = cliHash("supersecret123");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(serverVerify(hash, "supersecret123")).toBe(true);
    expect(serverVerify(hash, "wrong")).toBe(false);
  });
});

describe("CLI `harbour admin create` (subprocess)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-boot-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[]) {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, HARBOUR_HOME: home },
        encoding: "utf-8",
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("creates the first instance admin", () => {
    const r = run([
      "admin",
      "create",
      "--email",
      "admin@example.com",
      "--name",
      "Admin",
      "--password",
      "supersecret123",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Instance admin created");
  });

  it("rejects a password under 12 characters", () => {
    const r = run([
      "admin",
      "create",
      "--email",
      "admin@example.com",
      "--name",
      "Admin",
      "--password",
      "elevenchars",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toContain("at least 12 characters");
  });

  it("refuses to create a second instance admin without --force", () => {
    const first = run([
      "admin",
      "create",
      "--email",
      "admin@example.com",
      "--name",
      "Admin",
      "--password",
      "supersecret123",
    ]);
    expect(first.code).toBe(0);

    const second = run([
      "admin",
      "create",
      "--email",
      "admin2@example.com",
      "--name",
      "Admin2",
      "--password",
      "supersecret123",
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr + second.stdout).toContain("already exists");

    // --force overrides.
    const forced = run([
      "admin",
      "create",
      "--email",
      "admin2@example.com",
      "--name",
      "Admin2",
      "--password",
      "supersecret123",
      "--force",
    ]);
    expect(forced.code).toBe(0);
  });
});
