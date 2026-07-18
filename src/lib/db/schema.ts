import Database from "better-sqlite3";
import { encrypt } from "../encryption";
import { dbPath, ensureDir, harbourHome } from "../paths";

let _db: Database.Database | null = null;

// better-sqlite3 is a native addon locked to the Node ABI it was compiled
// against. If the active Node changed since `npm install`, loading it throws a
// cryptic NODE_MODULE_VERSION error; translate it into the actual fix.
function describeNativeError(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === "ERR_DLOPEN_FAILED" || msg.includes("NODE_MODULE_VERSION")) {
    return new Error(
      `Harbour can't load better-sqlite3: its native binary was built for a different Node.js version than the one you're running (${process.version}). ` +
        "This usually means your Node version changed since 'npm install' (e.g. via nvm). " +
        `Fix: run 'npm rebuild better-sqlite3' under Node ${process.version}, or switch back to the Node you installed with. Harbour targets Node 24 LTS.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export function getDb(): Database.Database {
  if (!_db) {
    ensureDir(harbourHome());
    let db: Database.Database;
    try {
      db = new Database(dbPath());
    } catch (err) {
      throw describeNativeError(err);
    }
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Two runners polling one org can race to claim the same run. With a busy
    // timeout the loser waits for the winner's claim write instead of failing
    // immediately with SQLITE_BUSY; the guarded claim UPDATEs in runs.ts (which
    // only flip a run to 'running' while it is still scheduled/pending) then make
    // the lost claim a no-op rather than a double-claim.
    db.pragma("busy_timeout = 5000");
    try {
      initializeSchema(db);
    } catch (err) {
      // A drifted DB can make initializeSchema itself throw (e.g. a new index
      // referencing a column an old-shape table lacks). Prefer the precise
      // drift report over the raw SQLite error when drift is the cause.
      verifySchema(db);
      throw err;
    }
    verifySchema(db);
    _db = db;
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
 * True when err is better-sqlite3's unique-index violation. Used as the race
 * backstop behind the slug pre-checks in createOrg/createProject/createAgent.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * v2 schema — clean break, no migrations. Every table is created directly in
 * its final v2 shape. Org → Project (mandatory) → Agent / Job → Run; resources
 * (docs / env_vars / tables) are dual-tier (org-level or project-level).
 * Workflow jobs are dual-tier too (project_id NULL = org-level); agent jobs
 * are always project-level, enforced by the CHECK on jobs.
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
      slug TEXT NOT NULL,                    -- creation-time, immutable, filesystem-safe workspace path segment
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

    -- Instance-level runner registry. One row per runner (local or remote);
    -- replaces the file-based agent runner config and the per-org
    -- workflow_runners table. The local runner is one auto-provisioned row.
    -- Tenancy never reaches here — runners are org-agnostic; a 'local' runner
    -- claims any placement='local' work across all orgs. 'remote' runners are
    -- scoped by their authorized labels (+ optional org/agent scope).
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the bearer token (hbrn_…)
      tier TEXT NOT NULL CHECK(tier IN ('local','remote')),
      labels TEXT NOT NULL DEFAULT '[]',     -- JSON: placement labels this token is authorized to serve
      capabilities TEXT,                     -- JSON {kinds,clis,labels}: last-advertised host capabilities (health/display)
      scope TEXT,                            -- JSON {orgId?,agentId?} or NULL (unscoped — local tier)
      last_polled_at INTEGER,                -- updated on every claim/peek; drives the health surface
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Hierarchy ────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,                 -- creation-time, immutable, filesystem-safe workspace path segment
      archived_at INTEGER,                -- soft-delete (normal path); hard delete = admin escape hatch
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Operational entities — direct project_id, no linking tables ──────

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,                 -- creation-time, immutable, filesystem-safe workspace path segment
      description TEXT,
      cli TEXT,                           -- 'claude' | 'codex' | 'gemini'
      model TEXT,
      thinking TEXT,
      color TEXT,                         -- stored identity hue (user-selectable; name-hash fallback when null)
      eager INTEGER NOT NULL DEFAULT 0,
      placement TEXT NOT NULL DEFAULT 'local', -- routes this agent's runs to a runner tier/label
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level (workflow jobs only)
      kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind IN ('agent','workflow')),
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,   -- set for agent jobs, NULL for workflow jobs
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      schedule TEXT NOT NULL,
      -- Gate scripts. Each gate is a gist — a runtime plus a body the runner
      -- materializes to a per-job file and runs via the runtime's interpreter
      -- (bash/python/node). The *_runtime is NULL exactly when its *_script is.
      prerun_runtime TEXT CHECK(prerun_runtime IS NULL OR prerun_runtime IN ('bash','python','node')),
      prerun_script TEXT,                   -- agent job gate: exit 0 continues, 77 skips, other fails
      postrun_runtime TEXT CHECK(postrun_runtime IS NULL OR postrun_runtime IN ('bash','python','node')),
      postrun_script TEXT,                  -- post-agent hook (#29): runs after status finalization
      postrun_gates INTEGER NOT NULL DEFAULT 0, -- 0 = informational (never changes status), 1 = enforcing (nonzero overrides done->failed)
      workflow_runtime TEXT CHECK(workflow_runtime IS NULL OR workflow_runtime IN ('bash','python','node')),
      workflow_script TEXT,                 -- workflow job command: no agent/LLM involved
      placement TEXT NOT NULL DEFAULT 'local', -- workflow jobs: routes runs to a runner tier/label (agent jobs inherit from their agent)
      timeout_minutes INTEGER NOT NULL DEFAULT 30,
      model TEXT,
      thinking TEXT,
      title_format TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK(kind != 'agent' OR project_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,          -- denormalized
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,           -- denormalized; NULL = org-level job's run
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed')),
      title TEXT,
      placement TEXT NOT NULL DEFAULT 'local', -- denormalized at creation from agent/job; keeps the claim query flat
      claimed_by TEXT REFERENCES runners(id) ON DELETE SET NULL, -- which runner claimed this run
      exec_token_hash TEXT,                -- sha256 of the per-run executor token (hbx_…); minted at claim, the CLI's callback credential
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
      author_type TEXT NOT NULL CHECK(author_type IN ('agent','user','system','workflow')),
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

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level
      name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,    -- physical SQLite table name, globally unique
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS table_migrations (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
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

    CREATE TABLE IF NOT EXISTS job_tables (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, table_id)
    );

    -- ── Instance settings (true instance-global KV only) ─────────────────

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);
    CREATE INDEX IF NOT EXISTS idx_set_password_tokens_hash ON set_password_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_slug ON orgs(slug);

    CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_org_slug ON projects(org_id, slug);

    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_slug ON agents(project_id, slug);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runners_token ON runners(token_hash);
    CREATE INDEX IF NOT EXISTS idx_jobs_org ON jobs(org_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_schedule ON jobs(kind, agent_id, active, next_run_at);

    CREATE INDEX IF NOT EXISTS idx_runs_org ON runs(org_id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_claimed_by ON runs(claimed_by);

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
    CREATE INDEX IF NOT EXISTS idx_tables_org_project ON tables(org_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_table_migrations_tbl ON table_migrations(table_id);
  `);

  ensureRunActivityAuthorTypes(db);

  // Ensure encryption key exists (generates on first run)
  try {
    encrypt("init");
  } catch {
    /* non-fatal */
  }
}

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function describeColumn(c: ColumnInfo): string {
  const parts = [c.type || "ANY"];
  if (c.notnull) parts.push("NOT NULL");
  if (c.dflt_value != null) parts.push(`DEFAULT ${c.dflt_value}`);
  if (c.pk) parts.push("PRIMARY KEY");
  return parts.join(" ");
}

/**
 * Diff the live DB against the schema this build expects. The expected shape
 * is derived by running initializeSchema against a throwaway in-memory DB —
 * the same code path that creates real databases — so the check can never go
 * stale. Returns human-readable drift lines; empty means in sync.
 *
 * Compares table columns structurally (by name, order-insensitive, so a
 * future ALTER-based migration path stays compatible) and index definitions
 * textually — a stale same-name index makes CREATE INDEX IF NOT EXISTS a
 * silent no-op, so existence alone isn't enough. Tables the schema doesn't
 * define (agent-managed `t_*` data tables) are ignored.
 */
export function diffSchema(live: Database.Database): string[] {
  const expected = new Database(":memory:");
  try {
    initializeSchema(expected);
    const drift: string[] = [];

    const tableNames = (db: Database.Database) =>
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
    const columns = (db: Database.Database, table: string) =>
      db
        .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
        .all(table) as ColumnInfo[];

    for (const table of tableNames(expected)) {
      const want = columns(expected, table);
      const have = columns(live, table);
      if (have.length === 0) {
        drift.push(`table ${table}: missing`);
        continue;
      }
      const haveByName = new Map(have.map((c) => [c.name, c]));
      const wantByName = new Map(want.map((c) => [c.name, c]));
      for (const col of want) {
        const got = haveByName.get(col.name);
        if (!got) {
          drift.push(`table ${table}: missing column ${col.name} (${describeColumn(col)})`);
        } else if (
          got.type !== col.type ||
          got.notnull !== col.notnull ||
          got.dflt_value !== col.dflt_value ||
          got.pk !== col.pk
        ) {
          drift.push(
            `table ${table}: column ${col.name} differs (expected ${describeColumn(col)}, found ${describeColumn(got)})`,
          );
        }
      }
      for (const col of have) {
        if (!wantByName.has(col.name)) {
          drift.push(`table ${table}: unexpected column ${col.name}`);
        }
      }
    }

    const indexes = (db: Database.Database) =>
      db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`)
        .all() as { name: string; sql: string }[];
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const liveIndexes = new Map(indexes(live).map((i) => [i.name, normalize(i.sql)]));
    for (const idx of indexes(expected)) {
      const got = liveIndexes.get(idx.name);
      const want = normalize(idx.sql);
      if (got === undefined) drift.push(`index ${idx.name}: missing`);
      else if (got !== want)
        drift.push(`index ${idx.name}: differs (expected "${want}", found "${got}")`);
    }

    return drift;
  } finally {
    expected.close();
  }
}

/**
 * Refuse to run against an out-of-sync database. v2 has no schema migrations,
 * so a drifted DB is an unsupported state — failing at startup with a precise
 * diff beats booting "fine" and 500ing at runtime with cryptic SQLite errors.
 */
export function verifySchema(db: Database.Database) {
  const drift = diffSchema(db);
  if (drift.length === 0) return;
  throw new Error(
    [
      `Database schema at ${dbPath()} is out of sync with this version of Harbour:`,
      ...drift.map((d) => `  - ${d}`),
      ``,
      `Harbour v2 has no schema migrations — a fresh database is the only supported path.`,
      `Move or delete the database file and restart to recreate it, or apply the`,
      `changes above manually if you need to keep existing data.`,
    ].join("\n"),
  );
}

/**
 * In-place fix-up for databases created before 'workflow' was a valid
 * run_activity.author_type. CREATE TABLE IF NOT EXISTS leaves the original
 * CHECK in place and SQLite can't ALTER one, so rebuild the table once.
 * Runs on every startup; no-op when the DDL already allows 'workflow'.
 */
function ensureRunActivityAuthorTypes(db: Database.Database) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_activity'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'workflow'")) return;

  // FKs off so DROP TABLE doesn't fire run_attachments' ON DELETE SET NULL
  // (pragma changes are illegal inside a transaction, so toggle outside it).
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE run_activity_v2 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK(author_type IN ('agent','user','system','workflow')),
        author_id TEXT,
        author_name TEXT,
        content TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO run_activity_v2 SELECT id, run_id, author_type, author_id, author_name, content, created_at FROM run_activity;
      DROP TABLE run_activity;
      ALTER TABLE run_activity_v2 RENAME TO run_activity;
      CREATE INDEX IF NOT EXISTS idx_run_activity_run ON run_activity(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_activity_run_time ON run_activity(run_id, created_at);
      COMMIT;
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
