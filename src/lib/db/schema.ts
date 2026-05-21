import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getNextRunTime, normalizeSchedule } from "../schedule";
import { encrypt } from "../encryption";
import { dbPath, harbourHome, ensureDir } from "../paths";

let _db: Database.Database | null = null;

type TableInfoRow = { name: string; notnull?: number };
type SqliteMasterRow = { sql: string };

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

function withForeignKeysDisabled(db: Database.Database, fn: () => void) {
  db.pragma("foreign_keys = OFF");
  try {
    fn();
  } finally {
    db.pragma("foreign_keys = ON");
  }
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
      scope_type TEXT NOT NULL DEFAULT 'global' CHECK(scope_type IN ('global','workspace','project')),
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      composio_cli_enabled INTEGER NOT NULL DEFAULT 0,
      composio_mcp_enabled INTEGER NOT NULL DEFAULT 0,
      composio_toolkits TEXT,
      composio_tools TEXT,
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
      workflow_command TEXT,
      workflow_only INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      thinking TEXT,
      credential_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL,
      title_format TEXT,
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
      extra_instructions TEXT,
      session_id TEXT,
      session_cwd TEXT,
      title TEXT,
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

    -- Credential profiles: per-person provider account/key bundles.
    -- Secrets themselves stay in env_vars and are injected by the broker.
    CREATE TABLE IF NOT EXISTS credential_profiles (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      notes TEXT,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      env_name TEXT NOT NULL,
      env_var_id TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
      account_email TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','waiting','blocked','revoked','failed')),
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(profile_id, provider, env_name)
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

    -- Notifications: human-facing inbox items produced by agents and workflows
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread','read','archived')),
      analysis_status TEXT NOT NULL DEFAULT 'not_started' CHECK(analysis_status IN ('not_started','analysis_pending','analyzed','failed')),
      analysis_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      analysis_summary TEXT,
      analysis_score INTEGER,
      analysis_category TEXT CHECK(analysis_category IN ('adopt','watch','ignore','research','action')),
      analysis_output_path TEXT,
      repo_count INTEGER,
      top_score INTEGER,
      keywords_json TEXT,
      categories_json TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      read_at INTEGER,
      archived_at INTEGER,
      UNIQUE(source_run_id, source_type)
    );

    -- Workspaces: top-level business/operating areas
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'workspace',
      root_path TEXT,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Projects: optional organizational grouping (view layer only)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
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

    -- Skills: reusable capabilities and brand kits imported from SKILLS/
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','workspace','project','brand-kit')),
      owner_workspace TEXT,
      owner_project TEXT,
      source_agent TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','draft','archived')),
      path TEXT,
      provenance TEXT,
      version TEXT,
      dependencies TEXT,
      agent_compatibility TEXT,
      tags TEXT,
      triggers TEXT,
      digest TEXT,
      content TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS skill_proposals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','workspace','project','brand-kit')),
      owner_workspace TEXT,
      owner_project TEXT,
      source_agent TEXT,
      path TEXT,
      provenance TEXT,
      version TEXT,
      dependencies TEXT,
      agent_compatibility TEXT,
      tags TEXT,
      triggers TEXT,
      digest TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','promoted','rejected')),
      rejection_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('include','exclude')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, skill_id)
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

    -- Captain: real-time chat conversations with CLI tools
    CREATE TABLE IF NOT EXISTS captain_conversations (
      id TEXT PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_source_run ON notifications(source_run_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_analysis_run ON notifications(analysis_run_id);

    CREATE INDEX IF NOT EXISTS idx_run_attachments_run ON run_attachments(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_attachments_activity ON run_attachments(activity_id);
    CREATE INDEX IF NOT EXISTS idx_doc_revisions_doc ON doc_revisions(doc_id);
    CREATE INDEX IF NOT EXISTS idx_database_migrations_db ON database_migrations(database_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(agent_id, active, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_run_activity_run_time ON run_activity(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_credentials_profile ON provider_credentials(profile_id);
    CREATE INDEX IF NOT EXISTS idx_provider_credentials_env_var ON provider_credentials(env_var_id);

    CREATE INDEX IF NOT EXISTS idx_captain_conversations_user ON captain_conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_captain_messages_conversation ON captain_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_captain_output_conversation ON captain_output(conversation_id);
  `);

  // Migrations: drop agent_id from docs (now top-level)
  const docCols = db.prepare(`PRAGMA table_info(docs)`).all() as TableInfoRow[];
  if (docCols.some((c) => c.name === "agent_id")) {
    db.exec(`DROP INDEX IF EXISTS idx_docs_agent`);
    db.exec(`ALTER TABLE docs DROP COLUMN agent_id`);
  }

  // Migrations: add 'pending' to runs status CHECK constraint
  // SQLite CHECK constraints can't be altered, so we recreate the table if needed
  const runCheck = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as SqliteMasterRow | undefined;
  if (runCheck?.sql && !runCheck.sql.includes("pending")) {
    withForeignKeysDisabled(db, () => db.exec(`
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
    `));
  }

  // Migrations: add one_off and timeout_minutes columns to jobs
  const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as TableInfoRow[];
  if (!jobCols.some((c) => c.name === "one_off")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0`);
  }
  if (!jobCols.some((c) => c.name === "timeout_minutes")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN timeout_minutes INTEGER NOT NULL DEFAULT 30`);
  }

  // Migrations: add 'scheduled' status and scheduled_for column to runs
  const runCheck2 = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as SqliteMasterRow | undefined;
  if (runCheck2?.sql && !runCheck2.sql.includes("scheduled")) {
    withForeignKeysDisabled(db, () => db.exec(`
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
    `));
  }

  // Migrations: add 'killed' status and kill_requested_at column to runs
  const runCheck3 = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'runs'`).get() as SqliteMasterRow | undefined;
  if (runCheck3?.sql && !runCheck3.sql.includes("killed")) {
    withForeignKeysDisabled(db, () => db.exec(`
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
    `));
  }

  // Migrations: normalize non-JSON schedule strings to canonical JSON
  // Migrations: workspaces + project ownership
  const workspaceCols = db.prepare(`PRAGMA table_info(workspaces)`).all() as TableInfoRow[];
  if (workspaceCols.length === 0) {
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'workspace',
        root_path TEXT,
        description TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }

  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all() as TableInfoRow[];
  const hadProjectWorkspaceId = projectCols.some((c) => c.name === "workspace_id");
  if (!hadProjectWorkspaceId) {
    db.exec(`ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  }

  const seedWorkspace = db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, name, slug, kind, root_path, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const workspaceSeeds = [
    ["borg-interface", "BORG Interface", "borg-interface", "system", "/Users/davidk/Documents/Borg Interface", "Umbrella workspace for the second brain, interface, skills, and local model config"],
    ["agent-research", "AGENT RESEARCH", "agent-research", "factory", "/Users/davidk/Documents/Borg Interface/AGENT RESEARCH", "AI coding factory: AgentOps, agents, evals, registries, and agent skills"],
    ["cultr-ventures", "CULTR VENTURES", "cultr-ventures", "business", "/Users/davidk/Documents/Borg Interface/CULTR VENTURES", "Dave's holding company workspace"],
    ["phaseone", "PhaseOne", "phaseone", "business", "/Users/davidk/Documents/Borg Interface/PhaseOne", "Dave's separate PhaseOne company workspace"],
  ];
  for (const row of workspaceSeeds) seedWorkspace.run(...row);

  const seedProject = db.prepare(`
    INSERT OR IGNORE INTO projects (id, workspace_id, name)
    VALUES (?, ?, ?)
  `);
  const projectSeeds = [
    ["tron-brain", "borg-interface", "TRON BRAIN"],
    ["harbour", "borg-interface", "harbour"],
    ["skills", "borg-interface", "SKILLS"],
    ["gemma-llm", "borg-interface", "GEMMA LLM"],
    ["agentops", "agent-research", "agentops"],
    ["deceived-rei-agent", "agent-research", "deceived_rei_agent"],
    ["hermes-x-intelligence-os", "agent-research", "hermes-x-intelligence-os"],
    ["clawdius-website-leads", "agent-research", "CLAWDIUS WEBSITE LEADs"],
    ["ironvision-production-scaffold", "agent-research", "ironvision-production-scaffold"],
    ["trendfinder", "agent-research", "trendFinder"],
    ["cantina-agentic-os", "cultr-ventures", "Cantina Agentic OS"],
    ["cultr-health-website", "cultr-ventures", "Cultr Health Website"],
    ["unit-project", "cultr-ventures", "UNIT-PRoject"],
    ["vidasocialapp", "cultr-ventures", "VidaSocialApp"],
    ["distressed-app-acquisition-engine", "cultr-ventures", "distressed_app_acquisition_engine"],
    ["rank-to-rent-prd-bundle", "cultr-ventures", "rank_to_rent_prd_bundle"],
    ["winston-salem-septic-pros", "cultr-ventures", "winston-salem-septic-pros"],
    ["newer-cantina", "phaseone", "Newer Cantina"],
    ["pops-coating", "phaseone", "Pops--Coating"],
    ["tm8", "phaseone", "TM8"],
  ];
  for (const row of projectSeeds) seedProject.run(...row);
  if (!hadProjectWorkspaceId) {
    db.prepare(`UPDATE projects SET workspace_id = 'borg-interface' WHERE workspace_id IS NULL`).run();
  }

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
  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as TableInfoRow[];
  if (!agentCols.some((c) => c.name === "type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN type TEXT NOT NULL DEFAULT 'external'`);
  }
  if (!agentCols.some((c) => c.name === "cli")) {
    db.exec(`ALTER TABLE agents ADD COLUMN cli TEXT`);
  }
  if (!agentCols.some((c) => c.name === "model")) {
    db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
  }
  if (!agentCols.some((c) => c.name === "thinking")) {
    db.exec(`ALTER TABLE agents ADD COLUMN thinking TEXT`);
  }
  if (!agentCols.some((c) => c.name === "remote")) {
    db.exec(`ALTER TABLE agents ADD COLUMN remote INTEGER NOT NULL DEFAULT 0`);
  }
  if (!agentCols.some((c) => c.name === "eager")) {
    db.exec(`ALTER TABLE agents ADD COLUMN eager INTEGER NOT NULL DEFAULT 0`);
  }
  if (!agentCols.some((c) => c.name === "scope_type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'global'`);
  }
  if (!agentCols.some((c) => c.name === "workspace_id")) {
    db.exec(`ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  }
  if (!agentCols.some((c) => c.name === "project_id")) {
    db.exec(`ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
  }
  if (!agentCols.some((c) => c.name === "composio_cli_enabled")) {
    db.exec(`ALTER TABLE agents ADD COLUMN composio_cli_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!agentCols.some((c) => c.name === "composio_mcp_enabled")) {
    db.exec(`ALTER TABLE agents ADD COLUMN composio_mcp_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!agentCols.some((c) => c.name === "composio_toolkits")) {
    db.exec(`ALTER TABLE agents ADD COLUMN composio_toolkits TEXT`);
  }
  if (!agentCols.some((c) => c.name === "composio_tools")) {
    db.exec(`ALTER TABLE agents ADD COLUMN composio_tools TEXT`);
  }

  // Migrations: add pinned column to docs table
  const docCols2 = db.prepare(`PRAGMA table_info(docs)`).all() as TableInfoRow[];
  if (!docCols2.some((c) => c.name === "pinned")) {
    db.exec(`ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrations: add model, thinking, credential profile, and title format columns to jobs table
  const jobCols2 = db.prepare(`PRAGMA table_info(jobs)`).all() as TableInfoRow[];
  if (!jobCols2.some((c) => c.name === "model")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN model TEXT`);
  }
  if (!jobCols2.some((c) => c.name === "thinking")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN thinking TEXT`);
  }
  if (!jobCols2.some((c) => c.name === "credential_profile_id")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN credential_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL`);
  }
  if (!jobCols2.some((c) => c.name === "title_format")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN title_format TEXT`);
  }

  // Migrations: admin API keys table
  const adminKeyCols = db.prepare(`PRAGMA table_info(admin_api_keys)`).all() as TableInfoRow[];
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

  // Migrations: add extra_instructions, session_id, session_cwd, and title columns to runs
  const runCols = db.prepare(`PRAGMA table_info(runs)`).all() as TableInfoRow[];
  if (!runCols.some((c) => c.name === "extra_instructions")) {
    db.exec(`ALTER TABLE runs ADD COLUMN extra_instructions TEXT`);
  }
  if (!runCols.some((c) => c.name === "session_id")) {
    db.exec(`ALTER TABLE runs ADD COLUMN session_id TEXT`);
  }
  if (!runCols.some((c) => c.name === "session_cwd")) {
    db.exec(`ALTER TABLE runs ADD COLUMN session_cwd TEXT`);
  }
  if (!runCols.some((c) => c.name === "title")) {
    db.exec(`ALTER TABLE runs ADD COLUMN title TEXT`);
  }

  // Migrations: rename check_command → workflow_command, add workflow_only
  const jobCols3 = db.prepare(`PRAGMA table_info(jobs)`).all() as TableInfoRow[];
  if (jobCols3.some((c) => c.name === "check_command")) {
    db.exec(`ALTER TABLE jobs RENAME COLUMN check_command TO workflow_command`);
  }
  if (!jobCols3.some((c) => c.name === "workflow_only")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN workflow_only INTEGER NOT NULL DEFAULT 0`);
  }

  // Migration: make agent_id nullable on jobs (for workflow-only jobs without an agent)
  const jobAgentCol = (db.prepare(`PRAGMA table_info(jobs)`).all() as TableInfoRow[])
    .find((c) => c.name === "agent_id");
  if (jobAgentCol?.notnull === 1) {
    withForeignKeysDisabled(db, () => db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS runs_preserve AS SELECT * FROM runs;
      DROP TABLE IF EXISTS jobs_new;
      CREATE TABLE jobs_new (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        schedule TEXT NOT NULL,
        workflow_command TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        one_off INTEGER NOT NULL DEFAULT 0,
        timeout_minutes INTEGER NOT NULL DEFAULT 30,
        model TEXT,
        thinking TEXT,
        workflow_only INTEGER NOT NULL DEFAULT 0,
        credential_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL,
        title_format TEXT
      );
      INSERT INTO jobs_new (
        id, agent_id, name, description, instructions, schedule, workflow_command,
        active, last_run_at, next_run_at, created_at, updated_at, one_off,
        timeout_minutes, model, thinking, workflow_only, credential_profile_id, title_format
      )
      SELECT
        id, agent_id, name, description, instructions, schedule, workflow_command,
        active, last_run_at, next_run_at, created_at, updated_at, one_off,
        timeout_minutes, model, thinking, workflow_only, credential_profile_id, title_format
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(agent_id, active, next_run_at);
      INSERT OR IGNORE INTO runs SELECT * FROM runs_preserve;
      DROP TABLE runs_preserve;
    `));
  }

  // Migration: make agent_id nullable on runs (for agentless workflow runs)
  const runAgentCol = (db.prepare(`PRAGMA table_info(runs)`).all() as TableInfoRow[])
    .find((c) => c.name === "agent_id");
  if (runAgentCol?.notnull === 1) {
    withForeignKeysDisabled(db, () => db.exec(`
      DROP TABLE IF EXISTS runs_new;
      CREATE TABLE runs_new (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed')),
        scheduled_for INTEGER,
        claimed_at INTEGER,
        completed_at INTEGER,
        kill_requested_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        extra_instructions TEXT,
        session_id TEXT,
        session_cwd TEXT,
        title TEXT
      );
      INSERT INTO runs_new (
        id, job_id, agent_id, status, scheduled_for, claimed_at, completed_at,
        kill_requested_at, created_at, updated_at, extra_instructions,
        session_id, session_cwd, title
      )
      SELECT
        id, job_id, agent_id, status, scheduled_for, claimed_at, completed_at,
        kill_requested_at, created_at, updated_at, extra_instructions,
        session_id, session_cwd, title
      FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `));
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents(scope_type, workspace_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope, owner_workspace, owner_project, status);
    CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_credential_profile ON jobs(credential_profile_id);
    CREATE INDEX IF NOT EXISTS idx_credential_profiles_email ON credential_profiles(email);
    CREATE INDEX IF NOT EXISTS idx_provider_credentials_lookup ON provider_credentials(profile_id, provider, env_name);
    CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_source_run ON notifications(source_run_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_analysis_run ON notifications(analysis_run_id);
  `);

  const skillCols = db.prepare(`PRAGMA table_info(skills)`).all() as TableInfoRow[];
  if (!skillCols.some((c) => c.name === "agent_compatibility")) {
    db.exec(`ALTER TABLE skills ADD COLUMN agent_compatibility TEXT`);
  }
  const skillProposalCols = db.prepare(`PRAGMA table_info(skill_proposals)`).all() as TableInfoRow[];
  if (!skillProposalCols.some((c) => c.name === "agent_compatibility")) {
    db.exec(`ALTER TABLE skill_proposals ADD COLUMN agent_compatibility TEXT`);
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

  const timezone = (db.prepare(`SELECT value FROM settings WHERE key = 'timezone'`).get() as { value: string } | undefined)?.value
    || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const toolkitSchedule = normalizeSchedule("daily at 7am") || JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], time: "07:00" });
  const toolkitNextRunAt = getNextRunTime(toolkitSchedule, undefined, timezone);
  const existingJobCount = (db.prepare(`SELECT COUNT(*) as n FROM jobs`).get() as { n: number }).n;
  const hasToolkitJob = db.prepare(`SELECT 1 FROM jobs WHERE id = ?`).get("harbour-toolkit-library-sync-7am");
  if (existingJobCount === 0 || hasToolkitJob) {
  db.prepare(`
    INSERT INTO jobs (
      id, agent_id, name, description, instructions, schedule, workflow_command,
      workflow_only, timeout_minutes, one_off, active, next_run_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, 1, 10, 0, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      instructions = excluded.instructions,
      schedule = excluded.schedule,
      workflow_command = excluded.workflow_command,
      workflow_only = 1,
      timeout_minutes = 10,
      one_off = 0,
      active = 1,
      next_run_at = COALESCE(jobs.next_run_at, excluded.next_run_at),
      updated_at = unixepoch()
  `).run(
    "harbour-toolkit-library-sync-7am",
    "Toolkit Library Sync",
    "Refreshes BORG skills, plugins, sub-agent manifests, and first-class AgentOps agents for OpenCLaw, Hermes, Harbour, and Orgo client VMs.",
    "Daily 7am maintenance job. Imports SKILLS into Harbour, snapshots plugin/sub-agent manifests, syncs AgentOps-declared Harbour agents/jobs idempotently, preserves X Developer credential-onboarding hooks for the X.com agent scraper, and marks OpenCLaw/Hermes agents updated so their next spawn reads the latest scoped toolkit packet.",
    toolkitSchedule,
    "node '/Users/davidk/Documents/Borg Interface/harbour/scripts/sync-toolkit-libraries.mjs'",
    toolkitNextRunAt,
  );
  }
}
