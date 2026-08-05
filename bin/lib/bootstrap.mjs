// CLI bootstrap: create the first user on a fresh harbour install.
//
// Bootstrap is a CLI flow (not a web page) — the operator has shell access on
// the host, so first-run setup belongs there with no unauthenticated web route
// to lock down. `harbour setup` is interactive; `harbour user create` takes
// flags. Both refuse to run once a user exists (use --force to add an extra
// one anyway).
//
// This module talks to the SQLite DB directly with better-sqlite3 + the same
// argon2id hashing the server uses, so it works whether or not the Next.js
// server is running. It only needs the `users` table; the server creates the
// full schema on its first connection. The CREATE here is idempotent and
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
import { installRunner, supportsRunnerService } from "./install.mjs";
import { defaultServerUrl, initialRunnerUrl } from "./server-config.mjs";

const ARGON2_OPTS = { algorithm: Algorithm.Argon2id };

function harbourHome() {
  return process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
}

/** Resolve the SQLite DB file the CLI operates on. Shared by other bin/ commands. */
export function dbPath() {
  return process.env.HARBOUR_DB_PATH || path.join(harbourHome(), "harbour.db");
}

// better-sqlite3 is a native addon: its compiled binary is locked to the Node
// ABI it was built against. If the active Node changed since `npm install`
// (common when nvm hands different windows different versions), the raw loader
// error is a cryptic NODE_MODULE_VERSION stack trace. Translate it into the fix.
export function describeNativeError(err) {
  const msg = String(err?.message ?? err);
  if (err?.code === "ERR_DLOPEN_FAILED" || msg.includes("NODE_MODULE_VERSION")) {
    return new Error(
      `Harbour can't load better-sqlite3: its native binary was built for a different Node.js version than the one you're running (${process.version}).\n` +
        "This usually means your Node version changed since 'npm install' (e.g. nvm picked a different version in this window).\n" +
        `Fix: run 'npm rebuild better-sqlite3' (or 'npm install') under Node ${process.version}, or switch back to the Node you installed with.\n` +
        "Harbour targets Node 24 LTS.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function openDb() {
  const dir = harbourHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let db;
  try {
    db = new Database(dbPath());
  } catch (err) {
    throw describeNativeError(err);
  }
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
      password_hash TEXT,                 -- NULLABLE: created without one, set-password link not yet consumed
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the bearer token (hbrn_…)
      tier TEXT NOT NULL CHECK(tier IN ('local','remote')),
      labels TEXT NOT NULL DEFAULT '[]',     -- JSON: placement labels this token is authorized to serve
      capabilities TEXT,                     -- JSON {kinds,clis,labels}: last-advertised host capabilities (health/display)
      scope TEXT,                            -- JSON {agentId?} or NULL (unscoped — local tier)
      last_polled_at INTEGER,                -- updated on every claim/peek; drives the health surface
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_runners_token ON runners(token_hash);
  `);
  return db;
}

/** True if any user already exists. */
export function userExists(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  return row.n > 0;
}

/**
 * Insert a user. Throws on duplicate email. argon2id hash matches the
 * server's verifier. Exported so tests can exercise it against an in-memory DB.
 */
export function insertUser(db, { email, displayName, password }) {
  const id = crypto.randomUUID();
  const passwordHash = hashSync(password, ARGON2_OPTS);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES (?, ?, ?, ?)`,
  ).run(id, email, passwordHash, displayName);
  return id;
}

/**
 * Provision the local runner if one doesn't exist yet: insert a `tier='local'`
 * row into the registry and write its token + local server URL under
 * ~/.harbour/ (token mode 0600).
 * Idempotent — a second call is a no-op once a local runner exists, so it's safe
 * to run on every setup / user-create. This is what makes a fresh install "just
 * work": no minting, no connect blobs. Returns { provisioned, id }.
 */
export function provisionLocalRunner(db, { url = initialRunnerUrl() } = {}) {
  const existing = db.prepare(`SELECT id FROM runners WHERE tier = 'local' LIMIT 1`).get();
  if (existing) return { provisioned: false, id: existing.id };

  const id = crypto.randomUUID();
  const token = `hbrn_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  // Keep the registry retryable if credential persistence fails. Filesystem
  // writes cannot participate in SQLite's transaction, but a thrown write rolls
  // the row back; a retry safely overwrites any partial credential file.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO runners (id, name, token_hash, tier, labels) VALUES (?, ?, ?, 'local', ?)`,
    ).run(id, "Local runner", tokenHash, JSON.stringify(["local"]));
    saveRunnerCredentials({ token, url });
  })();
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
 * Shared creation path: validate, guard against an existing user (unless
 * forced), insert. Returns { id, email }.
 */
function createUser({ email, displayName, password, force }) {
  if (!isValidEmail(email)) throw new Error("A valid email is required.");
  if (!displayName?.trim()) throw new Error("A display name is required.");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");

  const db = openDb();
  try {
    return db.transaction(() => {
      if (!force && userExists(db)) {
        throw new Error(
          "A user already exists. Bootstrap is first-run only. " +
            "Add more users from the dashboard's Users page, or pass --force to override.",
        );
      }
      const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
      if (existing) throw new Error(`A user with email ${email} already exists.`);
      const id = insertUser(db, { email, displayName: displayName.trim(), password });
      const runner = provisionLocalRunner(db);
      return { id, email, runner };
    })();
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
    const exists = userExists(db);
    db.close();
    if (exists && !force) {
      console.error(
        "A user already exists. Bootstrap is first-run only.\n" +
          "Add more users from the dashboard's Users page, or run with --force to override.",
      );
      process.exit(1);
    }

    console.log("Harbour first-run setup — create your first user.\n");
    const email = (await prompt(rl, "Email: ")).trim();
    const displayName = (await prompt(rl, "Display name: ")).trim();
    // Loop on the password pair: a typo or mismatch warns and re-prompts from
    // the main password rather than exiting and discarding the email/name above.
    let password;
    for (;;) {
      password = await promptHidden(rl, "Password (min 8 chars): ");
      if (password.length < 8) {
        console.error("⚠ Password must be at least 8 characters. Try again.");
        continue;
      }
      const confirm = await promptHidden(rl, "Confirm password: ");
      if (password !== confirm) {
        console.error("⚠ Passwords do not match. Try again.");
        continue;
      }
      break;
    }

    const { email: created, runner } = createUser({ email, displayName, password, force });
    console.log(`\nUser created: ${created}`);

    // Auto-provision the local runner so a fresh install "just works".
    if (runner.provisioned) {
      console.log(
        `Local runner provisioned — token at ${path.join(harbourHome(), "runner.token")} (0600).`,
      );
      if (supportsRunnerService()) {
        const answer = (
          await prompt(rl, "Install the runner service to poll for work every 60s? [Y/n]: ")
        )
          .trim()
          .toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") {
          if (!installRunner()) {
            throw new Error(
              "User and local runner were provisioned, but the runner service could not be installed.",
            );
          }
        } else {
          console.log(
            "Skipped. Start it later with `harbour install` (service) or `harbour run` (one-shot).",
          );
        }
      } else if (process.platform === "linux") {
        console.log(
          "Runner service installation is manual on Linux — use the systemd unit in docs/guides/deploy-to-production.md, or run `harbour run` once.",
        );
      } else {
        console.log(
          "Run `harbour run` to drain work; automatic service install is unavailable here.",
        );
      }
    }

    if (process.platform === "linux") {
      console.log(
        "\nHarbour is configured. Ensure the server service is running, then open its configured public URL.",
      );
    } else {
      console.log(
        `\nHarbour is configured. If the server is not already running, start it with \`npm start\`. Local URL: ${defaultServerUrl()}.`,
      );
    }
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

/** `harbour user create --email .. --name .. --password ..` — non-interactive. */
export async function runUserCreate(argv = []) {
  const flags = parseFlags(argv);
  const email = flags.email;
  const displayName = flags.name || flags["display-name"];
  const password = flags.password || process.env.HARBOUR_USER_PASSWORD;
  const force = !!flags.force;

  if (!email || !displayName || !password) {
    console.error(
      "Usage: harbour user create --email <email> --name <display name> --password <password> [--force]\n" +
        "       (password may also come from HARBOUR_USER_PASSWORD)",
    );
    process.exit(1);
  }

  try {
    const { email: created, runner } = createUser({ email, displayName, password, force });
    console.log(`User created: ${created}`);
    // Auto-provision the local runner (no service install in the non-interactive
    // path — the caller schedules it with `harbour install` when ready).
    if (runner.provisioned) {
      console.log(
        `Local runner provisioned — token at ${path.join(harbourHome(), "runner.token")} (0600).`,
      );
    }
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}
