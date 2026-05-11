import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema } from "@/lib/db/schema";

/**
 * Migration safety tests.
 *
 * The runtime migrations in initializeSchema rewrite the `jobs` and `runs`
 * tables to relax NOT NULL on `agent_id` (CREATE-INSERT-DROP-RENAME pattern,
 * since SQLite can't ALTER a constraint). These tests reproduce a realistic
 * pre-feature install — old-shape tables seeded with rows — then run
 * initializeSchema and assert that row counts, IDs, and column values all
 * survive the rewrite. They also assert idempotency: running the migration a
 * second time must be a no-op.
 *
 * If any of these break, a real install would lose data. Treat any failure
 * here as a release blocker.
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Seeds the DB with the schema shape that existed before any of the recent
 * column additions — explicitly the pre-`title_format`/`title`, pre-nullable
 * `agent_id` era. This is what an install upgrading from an older release
 * looks like on disk when `initializeSchema` runs for the first time.
 */
function seedOldShape(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      api_key_hash TEXT NOT NULL,
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- jobs: agent_id NOT NULL, no model/thinking/title_format/workflow_only.
    -- Matches the columns that existed in the pre-feature initial CREATE.
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      schedule TEXT NOT NULL,
      check_command TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- runs: agent_id NOT NULL, no extra_instructions/session/title columns
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','waiting','done','failed','skipped')),
      claimed_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Child tables referenced by FK from runs — exercise that ON DELETE
    -- CASCADE does not wipe these during the recreate.
    CREATE TABLE run_activity (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL,
      author_name TEXT,
      content TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('timezone', 'America/New_York');
  `);

  // Seed two agents, three jobs, four runs — enough to detect any row loss.
  db.prepare(`INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)`)
    .run("a1", "Dev Bot", "hash1");
  db.prepare(`INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)`)
    .run("a2", "Ops Bot", "hash2");

  const insertJob = db.prepare(
    `INSERT INTO jobs (id, agent_id, name, instructions, schedule, check_command, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertJob.run("j1", "a1", "Triage", "Find issues", '{"every":5}', null, 1);
  insertJob.run("j2", "a1", "Reports", "Daily report", '{"every":1440}', "echo gate", 1);
  insertJob.run("j3", "a2", "Cleanup", null, '{"every":60}', null, 0);

  const insertRun = db.prepare(
    `INSERT INTO runs (id, job_id, agent_id, status, claimed_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insertRun.run("r1", "j1", "a1", "done", 1700000000, 1700000100);
  insertRun.run("r2", "j1", "a1", "failed", 1700001000, 1700001050);
  insertRun.run("r3", "j2", "a1", "waiting", 1700002000, null);
  insertRun.run("r4", "j3", "a2", "skipped", 1700003000, 1700003020);

  // Activity rows on r1 + r3 — these should survive the runs recreate.
  const insertActivity = db.prepare(
    `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES (?, ?, ?, ?, ?)`
  );
  insertActivity.run("act1", "r1", "agent", "Bot", "started work");
  insertActivity.run("act2", "r1", "agent", "Bot", "done");
  insertActivity.run("act3", "r3", "user", "Gavin", "what's the status?");
}

beforeEach(() => {
  setDb(freshDb());
});

afterEach(() => {
  resetDb();
});

describe("Schema migration from old install", () => {
  it("preserves all rows when upgrading from pre-nullable-agent_id shape", () => {
    const db = freshDb();
    setDb(db);
    seedOldShape(db);

    initializeSchema(db);

    expect(db.prepare(`SELECT COUNT(*) as n FROM agents`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) as n FROM jobs`).get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT COUNT(*) as n FROM runs`).get()).toEqual({ n: 4 });
    // Activity rows must survive the runs recreate. Earlier versions of the
    // migration left FKs enabled during DROP TABLE runs, which cascade-deleted
    // every row in run_activity / run_output / run_attachments.
    expect(db.prepare(`SELECT COUNT(*) as n FROM run_activity`).get()).toEqual({ n: 3 });

    // Spot-check that specific rows survived intact with their original values.
    const j2 = db.prepare(`SELECT id, name, instructions, schedule, workflow_command, active FROM jobs WHERE id = ?`)
      .get("j2") as any;
    expect(j2).toMatchObject({
      id: "j2",
      name: "Reports",
      instructions: "Daily report",
      schedule: '{"every":1440}',
      workflow_command: "echo gate", // renamed from check_command — value preserved
      active: 1,
    });

    const r3 = db.prepare(`SELECT id, status, job_id, agent_id, completed_at FROM runs WHERE id = ?`)
      .get("r3") as any;
    expect(r3).toMatchObject({
      id: "r3",
      status: "waiting",
      job_id: "j2",
      agent_id: "a1",
      completed_at: null,
    });
  });

  it("adds title and title_format columns with NULL defaults", () => {
    const db = freshDb();
    setDb(db);
    seedOldShape(db);
    initializeSchema(db);

    const runCols = db.prepare(`PRAGMA table_info(runs)`).all() as any[];
    const titleCol = runCols.find(c => c.name === "title");
    expect(titleCol).toBeDefined();
    expect(titleCol.notnull).toBe(0);
    // Existing run rows seeded under the old schema have NULL title — the UI
    // falls back to job_name for these. New runs created via createRun() get
    // a populated title.
    expect(db.prepare(`SELECT title FROM runs WHERE id = 'r1'`).get()).toEqual({ title: null });

    const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as any[];
    const tfCol = jobCols.find(c => c.name === "title_format");
    expect(tfCol).toBeDefined();
    expect(tfCol.notnull).toBe(0);
    expect(db.prepare(`SELECT title_format FROM jobs WHERE id = 'j1'`).get()).toEqual({ title_format: null });
  });

  it("makes agent_id nullable on jobs and runs", () => {
    const db = freshDb();
    setDb(db);
    seedOldShape(db);
    initializeSchema(db);

    const jobAgent = (db.prepare(`PRAGMA table_info(jobs)`).all() as any[])
      .find(c => c.name === "agent_id");
    expect(jobAgent.notnull).toBe(0);

    const runAgent = (db.prepare(`PRAGMA table_info(runs)`).all() as any[])
      .find(c => c.name === "agent_id");
    expect(runAgent.notnull).toBe(0);

    // And the relaxed constraint is functional — agentless workflow inserts must work.
    expect(() => {
      db.prepare(`INSERT INTO jobs (id, name, schedule) VALUES ('wfj', 'Health Check', '{"every":60}')`).run();
    }).not.toThrow();
  });

  it("recovers from an orphaned jobs_new table left by a partial migration", () => {
    // Simulates the failure mode I hit in development: a previous run created
    // jobs_new but didn't complete the rename. The migration must drop the
    // orphan and proceed cleanly rather than failing with "table already exists".
    const db = freshDb();
    setDb(db);
    seedOldShape(db);
    db.exec(`CREATE TABLE jobs_new (id TEXT PRIMARY KEY, garbage TEXT)`);

    expect(() => initializeSchema(db)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) as n FROM jobs`).get()).toEqual({ n: 3 });
    // jobs_new is the rename source, so it shouldn't exist post-migration.
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_new'`).all();
    expect(tables).toEqual([]);
  });

  it("is idempotent — running initializeSchema twice is a no-op", () => {
    const db = freshDb();
    setDb(db);
    seedOldShape(db);

    initializeSchema(db);
    const afterFirst = db.prepare(`SELECT id, agent_id, status FROM runs ORDER BY id`).all();
    const jobsAfterFirst = db.prepare(`SELECT id, name, workflow_command FROM jobs ORDER BY id`).all();

    // Second run should not throw and should leave data unchanged.
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();

    expect(db.prepare(`SELECT id, agent_id, status FROM runs ORDER BY id`).all()).toEqual(afterFirst);
    expect(db.prepare(`SELECT id, name, workflow_command FROM jobs ORDER BY id`).all()).toEqual(jobsAfterFirst);

    // Columns should not be duplicated.
    const runCols = db.prepare(`PRAGMA table_info(runs)`).all() as any[];
    expect(runCols.filter(c => c.name === "title")).toHaveLength(1);
    const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as any[];
    expect(jobCols.filter(c => c.name === "title_format")).toHaveLength(1);
  });
});
