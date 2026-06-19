// Build a v1-shaped Harbour home (harbour.db + encryption.key) with edge-case
// data, for exercising `harbour migrate`. The schema mirrors the FINAL state of
// the v1 (main-branch) src/lib/db/schema.ts — base CREATEs plus every column its
// in-place ALTER migrations add (agents.type/cli/model/thinking/remote/eager,
// jobs.workflow_command/workflow_only/one_off/model/thinking/title_format,
// docs.pinned, admin_api_keys, …).
//
// Used by src/__tests__/migrate-v1.test.ts and runnable directly for a manual
// end-to-end:  node scripts/seed-v1-fixture.mjs <dir>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ALGORITHM = "aes-256-gcm";
function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const uuid = () => crypto.randomUUID();

const V1_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));

  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, api_key_hash TEXT NOT NULL,
    last_polled_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    type TEXT NOT NULL DEFAULT 'external', cli TEXT, model TEXT, thinking TEXT,
    remote INTEGER NOT NULL DEFAULT 0, eager INTEGER NOT NULL DEFAULT 0);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, instructions TEXT, schedule TEXT NOT NULL,
    workflow_command TEXT, active INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, next_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    one_off INTEGER NOT NULL DEFAULT 0, timeout_minutes INTEGER NOT NULL DEFAULT 30,
    model TEXT, thinking TEXT, workflow_only INTEGER NOT NULL DEFAULT 0, title_format TEXT);

  CREATE TABLE docs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_by_type TEXT, created_by_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    pinned INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE doc_revisions (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    content TEXT NOT NULL, author_type TEXT, author_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE job_docs (job_id TEXT NOT NULL, doc_id TEXT NOT NULL, PRIMARY KEY (job_id, doc_id));

  CREATE TABLE databases (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, table_name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE database_migrations (
    id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, description TEXT, sql TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE job_databases (job_id TEXT NOT NULL, database_id TEXT NOT NULL, PRIMARY KEY (job_id, database_id));

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE env_vars (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, encrypted_value TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE job_env_vars (job_id TEXT NOT NULL, env_var_id TEXT NOT NULL, PRIMARY KEY (job_id, env_var_id));

  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE project_agents (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (project_id, agent_id));
  CREATE TABLE project_jobs (project_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (project_id, job_id));
  CREATE TABLE project_docs (project_id TEXT NOT NULL, doc_id TEXT NOT NULL, PRIMARY KEY (project_id, doc_id));
  CREATE TABLE project_env_vars (project_id TEXT NOT NULL, env_var_id TEXT NOT NULL, PRIMARY KEY (project_id, env_var_id));
  CREATE TABLE project_databases (project_id TEXT NOT NULL, database_id TEXT NOT NULL, PRIMARY KEY (project_id, database_id));

  CREATE TABLE admin_api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_hash TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
`;

/**
 * Create a v1 home at `dir`. Returns identifiers + the admin email so a test can
 * line up the v2 instance admin for the dedup path.
 */
export function seedV1Fixture({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, "encryption.key"), key.toString("hex"), { mode: 0o600 });

  const dbFile = path.join(dir, "harbour.db");
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(V1_SCHEMA);

  const ids = {};
  const adminEmail = "admin@test.dev";

  // ── users (admin matches the v2 setup admin; alice is new) ──
  ids.adminUser = uuid();
  ids.aliceUser = uuid();
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)`).run(
    ids.adminUser,
    adminEmail,
    "$2a$10$bcrypthashplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "Admin",
  );
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)`).run(
    ids.aliceUser,
    "alice@test.dev",
    "$2a$10$anotherbcrypthashplaceholderxxxxxxxxxxxxxxxxxxxxxxxx",
    "Alice",
  );

  // ── projects ──
  ids.alpha = uuid();
  ids.beta = uuid();
  db.prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`).run(ids.alpha, "Alpha");
  db.prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`).run(ids.beta, "Beta");

  // ── agents ──
  const addAgent = (name, opts = {}) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO agents (id, name, description, api_key_hash, type, cli, model, thinking, remote, eager)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      opts.description || null,
      sha256(`key-${name}`),
      opts.type || "external",
      opts.cli || null,
      opts.model || null,
      opts.thinking || null,
      opts.remote ? 1 : 0,
      opts.eager ? 1 : 0,
    );
    return id;
  };
  ids.claudeDev = addAgent("Claude Dev", {
    type: "harbour",
    cli: "claude",
    model: "opus",
    thinking: "high",
    eager: true,
  });
  ids.remoteWorker = addAgent("Remote Worker", { type: "harbour", cli: "codex", remote: true });
  ids.multiAgent = addAgent("Multi Agent", { type: "harbour", cli: "gemini" });
  ids.externalBot = addAgent("External Bot"); // type external, no cli, no project

  db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.claudeDev,
  );
  db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(
    ids.beta,
    ids.remoteWorker,
  );
  db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.multiAgent,
  );
  db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(
    ids.beta,
    ids.multiAgent,
  );

  // ── docs ──
  const addDoc = (title, opts = {}) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO docs (id, title, created_by_type, created_by_id, pinned) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, title, opts.byType || null, opts.byId || null, opts.pinned ? 1 : 0);
    for (const [i, content] of (opts.revisions || []).entries()) {
      db.prepare(
        `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(uuid(), id, content, opts.byType || null, opts.byId || null, 1000 + i);
    }
    return id;
  };
  ids.brandGuide = addDoc("Brand Guide", {
    byType: "user",
    byId: ids.aliceUser,
    pinned: true,
    revisions: ["v1 brand content", "v2 brand content (latest)"],
  });
  ids.sharedStrategy = addDoc("Shared Strategy", { revisions: ["the strategy"] });
  ids.multiDoc = addDoc("Multi Doc", { revisions: ["shared across projects"] });
  ids.emptyDoc = addDoc("Empty Doc"); // no revisions

  db.prepare(`INSERT INTO project_docs (project_id, doc_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.brandGuide,
  );
  db.prepare(`INSERT INTO project_docs (project_id, doc_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.multiDoc,
  );
  db.prepare(`INSERT INTO project_docs (project_id, doc_id) VALUES (?, ?)`).run(
    ids.beta,
    ids.multiDoc,
  );

  // ── env vars (encrypted with the v1 key) ──
  const addEnv = (name, value, opts = {}) => {
    const id = uuid();
    db.prepare(`INSERT INTO env_vars (id, name, encrypted_value, pinned) VALUES (?, ?, ?, ?)`).run(
      id,
      name,
      encryptWith(key, value),
      opts.pinned ? 1 : 0,
    );
    return id;
  };
  ids.apiKey = addEnv("API_KEY", "secret-123");
  ids.globalToken = addEnv("GLOBAL_TOKEN", "tok-xyz", { pinned: true });
  db.prepare(`INSERT INTO project_env_vars (project_id, env_var_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.apiKey,
  );

  // ── databases (tables) + physical rows ──
  const addDatabase = (name, tableName, createCols, rows, projectId) => {
    const id = uuid();
    const createSql = `CREATE TABLE "${tableName}" (_id INTEGER PRIMARY KEY AUTOINCREMENT, ${createCols})`;
    db.exec(createSql);
    db.prepare(`INSERT INTO databases (id, name, table_name) VALUES (?, ?, ?)`).run(
      id,
      name,
      tableName,
    );
    db.prepare(
      `INSERT INTO database_migrations (id, database_id, version, description, sql) VALUES (?, ?, 1, ?, ?)`,
    ).run(uuid(), id, "Create table", createSql);
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(
        `INSERT INTO "${tableName}" (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(cols.map((c) => r[c]));
    }
    if (projectId)
      db.prepare(`INSERT INTO project_databases (project_id, database_id) VALUES (?, ?)`).run(
        projectId,
        id,
      );
    return id;
  };
  ids.leads = addDatabase(
    "leads",
    "t_leads",
    `"name" TEXT, "score" INTEGER NOT NULL DEFAULT 0`,
    [
      { name: "Acme", score: 10 },
      { name: "Globex", score: 20 },
      { name: "Initech", score: 0 },
    ],
    ids.alpha,
  );
  ids.globalMetrics = addDatabase(
    "global_metrics",
    "t_global_metrics",
    `"metric" TEXT, "value" REAL`,
    [
      { metric: "mrr", value: 1234.5 },
      { metric: "churn", value: 0.02 },
    ],
    null,
  );

  // ── jobs ──
  const addJob = (name, opts = {}) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO jobs (id, agent_id, name, description, instructions, schedule, workflow_command,
        active, one_off, timeout_minutes, model, thinking, workflow_only, title_format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.agentId || null,
      name,
      opts.description || null,
      opts.instructions || null,
      opts.schedule,
      opts.workflowCommand || null,
      opts.active === false ? 0 : 1,
      opts.oneOff ? 1 : 0,
      opts.timeout || 30,
      opts.model || null,
      opts.thinking || null,
      opts.workflowOnly ? 1 : 0,
      opts.titleFormat || null,
    );
    return id;
  };
  ids.dailyReport = addJob("Daily Report", {
    agentId: ids.claudeDev,
    instructions: "Write the daily report",
    schedule: '{"days":[1,2,3,4,5],"time":"09:00"}',
    model: "opus",
    thinking: "high",
    titleFormat: "Report {date}",
  });
  ids.gatedJob = addJob("Gated Job", {
    agentId: ids.claudeDev,
    instructions: "Only if gate passes",
    schedule: '{"every":60}',
    workflowCommand: "test -f /tmp/go", // combo → prerun gate
  });
  ids.cleanup = addJob("Cleanup", {
    agentId: ids.remoteWorker,
    schedule: '{"every":120}',
    workflowOnly: true,
    workflowCommand: "rm -rf /tmp/x",
    timeout: 15,
  });
  ids.nightlyBackup = addJob("Nightly Backup", {
    schedule: '{"days":[0],"time":"03:00"}',
    workflowOnly: true,
    workflowCommand: "backup.sh",
  });
  db.prepare(`INSERT INTO project_jobs (project_id, job_id) VALUES (?, ?)`).run(
    ids.alpha,
    ids.nightlyBackup,
  );

  ids.globalSweep = addJob("Global Sweep", {
    schedule: '{"every":1440}',
    workflowOnly: true,
    workflowCommand: "sweep.sh", // agentless, no project → org-level
  });
  ids.pausedJob = addJob("Paused Job", {
    agentId: ids.claudeDev,
    schedule: '{"every":30}',
    active: false,
  });
  ids.oneTime = addJob("One Time", {
    agentId: ids.claudeDev,
    schedule: '{"every":5}',
    oneOff: true,
  });
  ids.brokenSched = addJob("Broken Sched", { agentId: ids.claudeDev, schedule: "not a schedule" });

  // ── job links ──
  db.prepare(`INSERT INTO job_docs (job_id, doc_id) VALUES (?, ?)`).run(
    ids.dailyReport,
    ids.brandGuide,
  );
  db.prepare(`INSERT INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`).run(
    ids.dailyReport,
    ids.apiKey,
  );
  db.prepare(`INSERT INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`).run(
    ids.dailyReport,
    ids.globalToken,
  );
  db.prepare(`INSERT INTO job_databases (job_id, database_id) VALUES (?, ?)`).run(
    ids.dailyReport,
    ids.leads,
  );
  // org-level workflow linking a project-scoped secret → must be skipped by the migrator's tier guard
  db.prepare(`INSERT INTO job_env_vars (job_id, env_var_id) VALUES (?, ?)`).run(
    ids.globalSweep,
    ids.apiKey,
  );

  // ── admin api key + settings ──
  ids.adminKeyHash = sha256("admin-api-key-raw");
  db.prepare(
    `INSERT INTO admin_api_keys (id, name, api_key_hash, created_by_user_id, last_used_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(uuid(), "CI key", ids.adminKeyHash, ids.adminUser, 1700000000);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('timezone', ?)`).run("America/New_York");

  // ── v1 flat agent workspaces (to exercise migration's workspace report) ──
  // v1 nested all workspaces flat under the agent's slug. Give "Claude Dev" a
  // git repo and "External Bot" a plain dir; leave others empty.
  const wsRoot = path.join(dir, "workspaces");
  const claudeWs = path.join(wsRoot, "claude-dev");
  fs.mkdirSync(path.join(claudeWs, ".git"), { recursive: true });
  fs.writeFileSync(path.join(claudeWs, "README.md"), "# cloned repo\n");
  const extWs = path.join(wsRoot, "external-bot");
  fs.mkdirSync(extWs, { recursive: true });
  fs.writeFileSync(path.join(extWs, "notes.txt"), "scratch\n");

  db.close();
  return { dir, adminEmail, ids, keyHex: key.toString("hex") };
}

// CLI: node scripts/seed-v1-fixture.mjs <dir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/seed-v1-fixture.mjs <dir>");
    process.exit(1);
  }
  const r = seedV1Fixture({ dir: path.resolve(dir) });
  console.log(`Seeded v1 fixture at ${r.dir} (admin: ${r.adminEmail})`);
}
