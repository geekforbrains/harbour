// CLI bootstrap: create the first instance admin on a fresh harbour install.
//
// Bootstrap is a CLI flow (not a web page) — the operator has shell access on
// the host, so first-run setup belongs there with no unauthenticated web route
// to lock down. `harbour setup` is interactive; `harbour admin create` takes
// flags. Both refuse to run once an instance admin exists (use --force to add
// an extra one anyway).
//
// This module talks to the SQLite DB directly with better-sqlite3 + the same
// argon2id hashing the server uses, so it works whether or not the Next.js
// server is running. It only needs the `users` table; the server creates the
// full v2 schema on its first connection. The CREATE here is idempotent and
// byte-identical to src/lib/db/schema.ts so a CLI-bootstrapped DB matches a
// server-bootstrapped one.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Algorithm, hashSync, verifySync } from "@node-rs/argon2";
import Database from "better-sqlite3";
import { saveRunnerCredentials } from "./config.mjs";
import { installRunner } from "./install.mjs";

const ARGON2_OPTS = { algorithm: Algorithm.Argon2id };

function harbourHome() {
  return process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
}

function dbPath() {
  return process.env.HARBOUR_DB_PATH || path.join(harbourHome(), "harbour.db");
}

function openDb() {
  const dir = harbourHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Mirror the users + runners DDL from src/lib/db/schema.ts exactly. Idempotent:
  // a no-op if the server has already created the full schema. We need `runners`
  // here so setup can auto-provision the local runner before the server's first
  // boot. Keep these byte-identical to schema.ts.
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_runners_token ON runners(token_hash);
  `);
  return db;
}

/** True if any instance admin already exists. */
export function instanceAdminExists(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_instance_admin = 1`).get();
  return row.n > 0;
}

/**
 * Insert an instance admin. Throws on duplicate email. argon2id hash matches the
 * server's verifier. Exported so tests can exercise it against an in-memory DB.
 */
export function insertInstanceAdmin(db, { email, displayName, password }) {
  const id = crypto.randomUUID();
  const passwordHash = hashSync(password, ARGON2_OPTS);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, is_instance_admin)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(id, email, passwordHash, displayName);
  return id;
}

/**
 * Provision the local runner if one doesn't exist yet: insert a `tier='local'`
 * row into the registry and write its token to ~/.harbour/runner.token (0600).
 * Idempotent — a second call is a no-op once a local runner exists, so it's safe
 * to run on every setup / admin-create. This is what makes a fresh install "just
 * work": no minting, no connect blobs. Returns { provisioned, id }.
 */
export function provisionLocalRunner(db) {
  const existing = db.prepare(`SELECT id FROM runners WHERE tier = 'local' LIMIT 1`).get();
  if (existing) return { provisioned: false, id: existing.id };

  const id = crypto.randomUUID();
  const token = `hbrn_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare(
    `INSERT INTO runners (id, name, token_hash, tier, labels) VALUES (?, ?, ?, 'local', ?)`,
  ).run(id, "Local runner", tokenHash, JSON.stringify(["local"]));

  saveRunnerCredentials({ token }); // URL defaults to http://localhost:3000
  return { provisioned: true, id };
}

// Re-export the hashing for parity checks / tests.
export function hashPassword(password) {
  return hashSync(password, ARGON2_OPTS);
}
export function verifyPassword(hash, password) {
  try {
    return verifySync(hash, password, ARGON2_OPTS);
  } catch {
    return false;
  }
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
}

// Hidden password prompt (no echo). Mutes readline's echo entirely while the
// user types, then emits exactly one newline so the following prompt sits on
// the line directly below. Letting the Enter echo through as well would print
// a second newline and leave a blank line between the two password prompts.
function promptHidden(rl, question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const origWrite = rl.output.write.bind(rl.output);
    rl.output.write = () => {}; // swallow echo, including the Enter newline
    rl.question("", (answer) => {
      rl.output.write = origWrite;
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/**
 * Shared creation path: validate, guard against an existing admin (unless
 * forced), insert. Returns { id, email }.
 */
function createAdmin({ email, displayName, password, force }) {
  if (!isValidEmail(email)) throw new Error("A valid email is required.");
  if (!displayName?.trim()) throw new Error("A display name is required.");
  if (!password || password.length < 12)
    throw new Error("Password must be at least 12 characters.");

  const db = openDb();
  try {
    if (!force && instanceAdminExists(db)) {
      throw new Error(
        "An instance admin already exists. Bootstrap is first-run only. " +
          "Add more users from the dashboard's Users page, or pass --force to override.",
      );
    }
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (existing) throw new Error(`A user with email ${email} already exists.`);
    const id = insertInstanceAdmin(db, { email, displayName: displayName.trim(), password });
    return { id, email };
  } finally {
    db.close();
  }
}

/** `harbour setup` — interactive first-run bootstrap. */
export async function runSetup(argv = []) {
  const force = argv.includes("--force");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Early guard so we don't ask for input we can't use.
    const db = openDb();
    const exists = instanceAdminExists(db);
    db.close();
    if (exists && !force) {
      console.error(
        "An instance admin already exists. Bootstrap is first-run only.\n" +
          "Add more users from the dashboard's Users page, or run with --force to override.",
      );
      process.exit(1);
    }

    console.log("Harbour first-run setup — create the instance admin.\n");
    const email = (await prompt(rl, "Email: ")).trim();
    const displayName = (await prompt(rl, "Display name: ")).trim();
    // Loop on the password pair: a typo or mismatch warns and re-prompts from
    // the main password rather than exiting and discarding the email/name above.
    let password;
    for (;;) {
      password = await promptHidden(rl, "Password (min 12 chars): ");
      if (password.length < 12) {
        console.error("⚠ Password must be at least 12 characters. Try again.");
        continue;
      }
      const confirm = await promptHidden(rl, "Confirm password: ");
      if (password !== confirm) {
        console.error("⚠ Passwords do not match. Try again.");
        continue;
      }
      break;
    }

    const { email: created } = createAdmin({ email, displayName, password, force });
    console.log(`\nInstance admin created: ${created}`);

    // Auto-provision the local runner so a fresh install "just works".
    const rdb = openDb();
    let provisioned;
    try {
      provisioned = provisionLocalRunner(rdb);
    } finally {
      rdb.close();
    }
    if (provisioned.provisioned) {
      console.log("Local runner provisioned — token at ~/.harbour/runner.token (0600).");
      const answer = (
        await prompt(rl, "Install the runner service to poll for work every 60s? [Y/n]: ")
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        installRunner();
      } else {
        console.log(
          "Skipped. Start it later with `harbour install` (service) or `harbour run` (one-shot).",
        );
      }
    }

    console.log("\nLog in at the dashboard, then create your first org, project, and users.");
  } finally {
    rl.close();
  }
}

/** Parse `--key value` / `--key=value` flags. */
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a === "--force") {
      out.force = true;
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

/** `harbour admin create --email .. --name .. --password ..` — non-interactive. */
export async function runAdminCreate(argv = []) {
  const flags = parseFlags(argv);
  const email = flags.email;
  const displayName = flags.name || flags["display-name"];
  const password = flags.password || process.env.HARBOUR_ADMIN_PASSWORD;
  const force = !!flags.force;

  if (!email || !displayName || !password) {
    console.error(
      "Usage: harbour admin create --email <email> --name <display name> --password <password> [--force]\n" +
        "       (password may also come from HARBOUR_ADMIN_PASSWORD)",
    );
    process.exit(1);
  }

  try {
    const { email: created } = createAdmin({ email, displayName, password, force });
    console.log(`Instance admin created: ${created}`);
    // Auto-provision the local runner (no service install in the non-interactive
    // path — the caller schedules it with `harbour install` when ready).
    const rdb = openDb();
    try {
      if (provisionLocalRunner(rdb).provisioned) {
        console.log("Local runner provisioned — token at ~/.harbour/runner.token (0600).");
      }
    } finally {
      rdb.close();
    }
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}
