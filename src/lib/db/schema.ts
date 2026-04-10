import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { normalizeSchedule } from "../schedule";
import { encrypt } from "../encryption";
import { dbPath, harbourHome, ensureDir } from "../paths";

let _db: Database.Database | null = null;

/**
 * One-time migration: if a legacy ./harbour.db exists in the cwd and the
 * default ~/.harbour/harbour.db doesn't, copy it (plus its WAL sidecars)
 * into the new home so the user can back up a single directory.
 *
 * Skipped when HARBOUR_DB_PATH is explicitly set.
 */
function migrateLegacyDbIfNeeded() {
  if (process.env.HARBOUR_DB_PATH) return;
  const target = dbPath();
  if (fs.existsSync(target)) return;

  const legacy = path.join(process.cwd(), "harbour.db");
  if (!fs.existsSync(legacy)) return;
  if (path.resolve(legacy) === path.resolve(target)) return;

  ensureDir(path.dirname(target));
  for (const ext of ["", "-shm", "-wal"]) {
    const src = legacy + ext;
    if (fs.existsSync(src)) fs.copyFileSync(src, target + ext);
  }
  console.log(`[harbour] Migrated ${legacy} → ${target} (original preserved)`);
}

export function getDb(): Database.Database {
  if (!_db) {
    ensureDir(harbourHome());
    migrateLegacyDbIfNeeded();
    _db = new Database(dbPath());
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initializeSchema(_db);
  }
  return _db;
}

export function setDb(db: Database.Database) {
  _db = db;
}

export function resetDb() {
  _db = null;
}

export function initializeSchema(db: Database.Database) {
  db.exec(`
    -- Users: human accounts for dashboard auth
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Agents: top-level entity, each has jobs/docs/data
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      api_key_hash TEXT NOT NULL,
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Jobs: recurring responsibilities assigned to an agent
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      schedule TEXT NOT NULL,
      check_command TEXT,

      timeout_minutes INTEGER NOT NULL DEFAULT 30,
      one_off INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Runs: single execution of a job
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed')),
      scheduled_for INTEGER,
      claimed_at INTEGER,
      completed_at INTEGER,
      kill_requested_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Run activity: ordered log of messages on a run
    CREATE TABLE IF NOT EXISTS run_activity (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK(author_type IN ('agent','user','system')),
      author_id TEXT,
      author_name TEXT,
      content TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Docs: top-level markdown documents, linked to jobs via job_docs
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_by_type TEXT CHECK(created_by_type IN ('user','agent')),
      created_by_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS doc_revisions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      author_type TEXT CHECK(author_type IN ('user','agent')),
      author_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Job-doc linking: which docs a job references
    CREATE TABLE IF NOT EXISTS job_docs (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, doc_id)
    );

    -- Databases: agent-managed SQLite tables (app-level, not agent-owned)
    CREATE TABLE IF NOT EXISTS databases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      table_name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Database migration history
    CREATE TABLE IF NOT EXISTS database_migrations (
      id TEXT PRIMARY KEY,
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      description TEXT,
      sql TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Job-database linking: which databases a job references
    CREATE TABLE IF NOT EXISTS job_databases (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, database_id)
    );

    -- System settings: key-value store
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Environment variables: encrypted key-value pairs injected at runtime
    CREATE TABLE IF NOT EXISTS env_vars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      encrypted_value TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Job-env linking: which env vars a job references
    CREATE TABLE IF NOT EXISTS job_env_vars (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      env_var_id TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, env_var_id)
    );

    -- Run attachments: files uploaded to a run, or URL embeds (Loom/YouTube/Vimeo)
    CREATE TABLE IF NOT EXISTS run_attachments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      activity_id TEXT REFERENCES run_activity(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file','embed')),
      -- file kind:
      filename TEXT,
      storage_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      -- embed kind:
      url TEXT,
      embed_provider TEXT,
      -- both:
      title TEXT,
      uploaded_by_type TEXT CHECK(uploaded_by_type IN ('user','agent')),
      uploaded_by_id TEXT,
      uploaded_by_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Run output: raw streaming events from CLI agent execution
    CREATE TABLE IF NOT EXISTS run_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Projects: optional organizational grouping (view layer only)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Project linking tables (many-to-many)
    CREATE TABLE IF NOT EXISTS project_agents (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS project_jobs (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, job_id)
    );

    CREATE TABLE IF NOT EXISTS project_docs (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, doc_id)
    );

    CREATE TABLE IF NOT EXISTS project_env_vars (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      env_var_id TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, env_var_id)
    );

    CREATE TABLE IF NOT EXISTS project_databases (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, database_id)
    );

    -- Video processing: tracks processing state for uploaded video attachments
    CREATE TABLE IF NOT EXISTS attachment_processing (
      id TEXT PRIMARY KEY,
      attachment_id TEXT NOT NULL UNIQUE REFERENCES run_attachments(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','processing','done','failed')),
      transcript_path TEXT,
      screenshots_dir TEXT,
      screenshot_count INTEGER NOT NULL DEFAULT 0,
      screenshot_interval INTEGER,
      duration_seconds REAL,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_attachment_processing_attachment ON attachment_processing(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_attachment_processing_run ON attachment_processing(run_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_run_activity_run ON run_activity(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_output_run ON run_output(run_id);

    CREATE INDEX IF NOT EXISTS idx_run_attachments_run ON run_attachments(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_attachments_activity ON run_attachments(activity_id);
    CREATE INDEX IF NOT EXISTS idx_doc_revisions_doc ON doc_revisions(doc_id);
    CREATE INDEX IF NOT EXISTS idx_database_migrations_db ON database_migrations(database_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(agent_id, active, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_run_activity_run_time ON run_activity(run_id, created_at);
  `);

  // Migrations: drop agent_id from docs (now top-level)
  const docCols = db.prepare(`PRAGMA table_info(docs)`).all() as any[];
  if (docCols.some((c: any) => c.name === "agent_id")) {
    db.exec(`DROP INDEX IF EXISTS idx_docs_agent`);
    db.exec(`ALTER TABLE docs DROP COLUMN agent_id`);
  }

  // Migrations: add 'pending' to runs status CHECK constraint
  // SQLite CHECK constraints can't be altered, so we recreate the table if needed
  const runCheck = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as any;
  if (runCheck?.sql && !runCheck.sql.includes("pending")) {
    db.exec(`
      DROP TABLE IF EXISTS runs_new;
      CREATE TABLE runs_new (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','waiting','pending','done','failed','skipped')),
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO runs_new SELECT * FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `);
  }

  // Migrations: add one_off and timeout_minutes columns to jobs
  const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as any[];
  if (!jobCols.some((c: any) => c.name === "one_off")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0`);
  }
  if (!jobCols.some((c: any) => c.name === "timeout_minutes")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN timeout_minutes INTEGER NOT NULL DEFAULT 30`);
  }

  // Migrations: add 'scheduled' status and scheduled_for column to runs
  const runCheck2 = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as any;
  if (runCheck2?.sql && !runCheck2.sql.includes("scheduled")) {
    db.exec(`
      DROP TABLE IF EXISTS runs_new;
      CREATE TABLE runs_new (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped')),
        scheduled_for INTEGER,
        claimed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO runs_new (id, job_id, agent_id, status, claimed_at, completed_at, created_at, updated_at)
        SELECT id, job_id, agent_id, status, claimed_at, completed_at, created_at, updated_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `);
  }

  // Migrations: add 'killed' status and kill_requested_at column to runs
  const runCheck3 = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as any;
  if (runCheck3?.sql && !runCheck3.sql.includes("killed")) {
    db.exec(`
      DROP TABLE IF EXISTS runs_new;
      CREATE TABLE runs_new (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed')),
        scheduled_for INTEGER,
        claimed_at INTEGER,
        completed_at INTEGER,
        kill_requested_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO runs_new (id, job_id, agent_id, status, scheduled_for, claimed_at, completed_at, created_at, updated_at)
        SELECT id, job_id, agent_id, status, scheduled_for, claimed_at, completed_at, created_at, updated_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `);
  }

  // Migrations: normalize non-JSON schedule strings to canonical JSON
  const nonJsonSchedules = db.prepare(
    `SELECT id, schedule FROM jobs WHERE schedule NOT LIKE '{%'`
  ).all() as { id: string; schedule: string }[];
  if (nonJsonSchedules.length > 0) {
    const update = db.prepare(`UPDATE jobs SET schedule = ? WHERE id = ?`);
    for (const row of nonJsonSchedules) {
      const normalized = normalizeSchedule(row.schedule);
      if (normalized) update.run(normalized, row.id);
    }
  }

  // Migrations: add type, cli, model columns to agents table for harbour agents
  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as any[];
  if (!agentCols.some((c: any) => c.name === "type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN type TEXT NOT NULL DEFAULT 'external'`);
  }
  if (!agentCols.some((c: any) => c.name === "cli")) {
    db.exec(`ALTER TABLE agents ADD COLUMN cli TEXT`);
  }
  if (!agentCols.some((c: any) => c.name === "model")) {
    db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
  }
  if (!agentCols.some((c: any) => c.name === "thinking")) {
    db.exec(`ALTER TABLE agents ADD COLUMN thinking TEXT`);
  }

  // Migrations: add pinned column to docs table
  const docCols2 = db.prepare(`PRAGMA table_info(docs)`).all() as any[];
  if (!docCols2.some((c: any) => c.name === "pinned")) {
    db.exec(`ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrations: add model and thinking columns to jobs table
  const jobCols2 = db.prepare(`PRAGMA table_info(jobs)`).all() as any[];
  if (!jobCols2.some((c: any) => c.name === "model")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN model TEXT`);
  }
  if (!jobCols2.some((c: any) => c.name === "thinking")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN thinking TEXT`);
  }

  // Migrations: admin API keys table
  const adminKeyCols = db.prepare(`PRAGMA table_info(admin_api_keys)`).all() as any[];
  if (adminKeyCols.length === 0) {
    db.exec(`
      CREATE TABLE admin_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }

  // Migrations: add extra_instructions, session_id, session_cwd columns to runs
  const runCols = db.prepare(`PRAGMA table_info(runs)`).all() as any[];
  if (!runCols.some((c: any) => c.name === "extra_instructions")) {
    db.exec(`ALTER TABLE runs ADD COLUMN extra_instructions TEXT`);
  }
  if (!runCols.some((c: any) => c.name === "session_id")) {
    db.exec(`ALTER TABLE runs ADD COLUMN session_id TEXT`);
  }
  if (!runCols.some((c: any) => c.name === "session_cwd")) {
    db.exec(`ALTER TABLE runs ADD COLUMN session_cwd TEXT`);
  }

  // Ensure encryption key exists (generates on first run)
  try { encrypt("init"); } catch { /* non-fatal */ }

  // Initialize default settings on first run
  const hasTz = db.prepare(`SELECT 1 FROM settings WHERE key = 'timezone'`).get();
  if (!hasTz) {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("timezone", systemTz);
  }
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("signup_enabled", "true");
}
