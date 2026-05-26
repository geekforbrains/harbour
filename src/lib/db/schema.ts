import Database from "better-sqlite3";
import { encrypt } from "../encryption";
import { dbPath, harbourHome, ensureDir } from "../paths";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    ensureDir(harbourHome());
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

/**
 * v2 schema — clean break, no migrations. Every table is created directly in
 * its final v2 shape. Org → Project (mandatory) → Agent / Job → Run; resources
 * (docs / env_vars / databases) are dual-tier (org-level or project-level).
 *
 * There is no v1 → v2 migration: a fresh DB is the only supported path.
 */
export function initializeSchema(db: Database.Database) {
  db.exec(`
    -- ── Identity + access ────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,                 -- NULLABLE: admin-created, set-password link not yet consumed
      display_name TEXT NOT NULL,
      is_instance_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      settings TEXT NOT NULL DEFAULT '{}',   -- JSON: { timezone, ... } (org-scoped)
      archived_at INTEGER,                   -- soft-delete
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id  TEXT NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, org_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS set_password_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,    -- sha256 of base64url(randomBytes(32))
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      expires_at INTEGER NOT NULL,        -- TTL 24h
      consumed_at INTEGER,                -- single-use; atomic consume in txn
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS admin_api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Hierarchy ────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      archived_at INTEGER,                -- soft-delete (normal path); hard delete = admin escape hatch
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Operational entities — direct project_id, no linking tables ──────

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      api_key_hash TEXT NOT NULL,
      cli TEXT,                           -- 'claude' | 'codex' | 'gemini'
      model TEXT,
      thinking TEXT,
      color TEXT,                         -- stored round-robin identity hue
      eager INTEGER NOT NULL DEFAULT 0,
      runner_fingerprint TEXT,            -- one-runtime-per-agent guard
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,   -- nullable = workflow-only
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      schedule TEXT NOT NULL,
      workflow_command TEXT,
      timeout_minutes INTEGER NOT NULL DEFAULT 30,
      model TEXT,
      thinking TEXT,
      title_format TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- denormalized
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed')),
      title TEXT,
      scheduled_for INTEGER,
      claimed_at INTEGER,
      completed_at INTEGER,
      kill_requested_at INTEGER,
      extra_instructions TEXT,
      session_id TEXT,
      session_cwd TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS run_activity (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK(author_type IN ('agent','user','system')),
      author_id TEXT,
      author_name TEXT,
      content TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS run_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS run_attachments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      activity_id TEXT REFERENCES run_activity(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file','embed')),
      filename TEXT,
      storage_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      url TEXT,
      embed_provider TEXT,
      title TEXT,
      uploaded_by_type TEXT CHECK(uploaded_by_type IN ('user','agent')),
      uploaded_by_id TEXT,
      uploaded_by_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

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

    -- ── Resources — dual-tier owner (org-level OR project-level) ─────────

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level
      title TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS env_vars (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      -- name uniqueness enforced in the query layer (project-over-org override)
    );

    CREATE TABLE IF NOT EXISTS databases (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level
      name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,    -- physical SQLite table name, globally unique
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS database_migrations (
      id TEXT PRIMARY KEY,
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      description TEXT,
      sql TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Job-linked resources (explicit attachments, tier 3) ──────────────

    CREATE TABLE IF NOT EXISTS job_docs (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, doc_id)
    );

    CREATE TABLE IF NOT EXISTS job_env_vars (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      env_var_id TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, env_var_id)
    );

    CREATE TABLE IF NOT EXISTS job_databases (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, database_id)
    );

    -- ── Instance settings (true instance-global KV only) ─────────────────

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── Captain (per-org) ────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS captain_conversations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      cli TEXT NOT NULL,
      model TEXT,
      thinking TEXT,
      session_id TEXT,
      cwd TEXT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS captain_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES captain_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS captain_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES captain_conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES captain_messages(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);
    CREATE INDEX IF NOT EXISTS idx_set_password_tokens_hash ON set_password_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(agent_id, active, next_run_at);

    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE INDEX IF NOT EXISTS idx_run_activity_run ON run_activity(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_activity_run_time ON run_activity(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_run_output_run ON run_output(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_attachments_run ON run_attachments(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_attachments_activity ON run_attachments(activity_id);
    CREATE INDEX IF NOT EXISTS idx_attachment_processing_attachment ON attachment_processing(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_attachment_processing_run ON attachment_processing(run_id);

    CREATE INDEX IF NOT EXISTS idx_docs_org_project ON docs(org_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_doc_revisions_doc ON doc_revisions(doc_id);
    CREATE INDEX IF NOT EXISTS idx_env_vars_org_project ON env_vars(org_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_databases_org_project ON databases(org_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_database_migrations_db ON database_migrations(database_id);

    CREATE INDEX IF NOT EXISTS idx_captain_conversations_org ON captain_conversations(org_id);
    CREATE INDEX IF NOT EXISTS idx_captain_conversations_user ON captain_conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_captain_messages_conversation ON captain_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_captain_output_conversation ON captain_output(conversation_id);
  `);

  // Ensure encryption key exists (generates on first run)
  try { encrypt("init"); } catch { /* non-fatal */ }
}
