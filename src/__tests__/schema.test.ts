import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createApiKey,
  createDoc,
  createEnvVar,
  createJob,
  createProject,
  createRun,
  createRunner,
  createSession,
  createTable,
  createUser,
  createWorkflow,
  deleteAgent,
  deleteProject,
  getAgentById,
  getDocById,
  getEnvVarById,
  getJobById,
  getProjectById,
  getRunById,
  getTableById,
} from "@/lib/db/queries";
import { diffSchema, getDb, initializeSchema, resetDb, setDb, verifySchema } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Setup / Teardown — fresh in-memory DB per test
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  const db = freshDb();
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hierarchy() {
  const project = createProject("Website")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  return { project, agent, job, run };
}

// ===========================================================================
// Schema shape + idempotency
// ===========================================================================

describe("schema", () => {
  it("is idempotent under repeated initializeSchema calls", () => {
    const db = getDb();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();
    // projects table exists exactly once
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='projects'`)
      .all();
    expect(tables).toHaveLength(1);
  });

  it("creates the full project → agent → job → run hierarchy", () => {
    const { project, agent, job, run } = hierarchy();
    expect(project.id).toBeDefined();
    expect(agent.project_id).toBe(project.id);
    expect(job.project_id).toBe(project.id);
    expect(job.agent_id).toBe(agent.id);
    expect(run.project_id).toBe(project.id); // denormalized from the job
    expect(run.job_id).toBe(job.id);
  });

  it("is flat: no org tables, no role columns, no archive columns", () => {
    const db = getDb();
    const tableNames = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tableNames).not.toContain("orgs");
    expect(tableNames).not.toContain("memberships");
    expect(tableNames).not.toContain("admin_api_keys");
    expect(tableNames).toContain("api_keys");

    const columnNames = (table: string) =>
      (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
        (c) => c.name,
      );
    expect(columnNames("users")).not.toContain("is_instance_admin");
    expect(columnNames("projects")).not.toContain("org_id");
    expect(columnNames("projects")).not.toContain("archived_at");
    for (const table of ["jobs", "runs", "docs", "env_vars", "tables"]) {
      expect(columnNames(table)).toContain("project_id");
      expect(columnNames(table)).not.toContain("org_id");
    }
  });

  it("api_keys: createApiKey mints an hbr_ key and stores only its hash", () => {
    const user = createUser("u@x.com", "pw", "U")!;
    const { apiKey } = createApiKey("management", user.id);
    expect(apiKey).toMatch(/^hbr_[0-9a-f]{64}$/);
    const row = getDb().prepare(`SELECT api_key_hash FROM api_keys`).get() as {
      api_key_hash: string;
    };
    expect(row.api_key_hash).not.toContain(apiKey);
  });
});

// ===========================================================================
// Schema drift detection (verifySchema / diffSchema)
// ===========================================================================

describe("schema drift detection", () => {
  it("reports no drift for a freshly initialized DB", () => {
    const db = getDb();
    expect(diffSchema(db)).toEqual([]);
    expect(() => verifySchema(db)).not.toThrow();
  });

  it("ignores agent-managed t_* data tables", () => {
    const db = getDb();
    db.exec(`CREATE TABLE t_leads_abc12345 (_id INTEGER PRIMARY KEY, email TEXT)`);
    expect(diffSchema(db)).toEqual([]);
  });

  it("detects a missing column left behind by CREATE TABLE IF NOT EXISTS", () => {
    const db = getDb();
    db.exec(`ALTER TABLE jobs DROP COLUMN prerun_script`);
    const drift = diffSchema(db);
    expect(drift).toContain("table jobs: missing column prerun_script (TEXT)");
    expect(() => verifySchema(db)).toThrow(/jobs: missing column prerun_script/);
    expect(() => verifySchema(db)).toThrow(/Harbour has no schema migrations/);
    expect(() => verifySchema(db)).toThrow(/fresh database is the only supported path/);
  });

  it("detects an unexpected (removed-from-schema) column", () => {
    const db = getDb();
    db.exec(`ALTER TABLE jobs ADD COLUMN legacy_flag INTEGER`);
    expect(diffSchema(db)).toContain("table jobs: unexpected column legacy_flag");
  });

  it("detects a stale index masking CREATE INDEX IF NOT EXISTS", () => {
    const db = getDb();
    db.exec(`
      DROP INDEX idx_jobs_schedule;
      CREATE INDEX idx_jobs_schedule ON jobs(agent_id, active, next_run_at);
    `);
    const drift = diffSchema(db);
    expect(drift.some((d) => d.startsWith("index idx_jobs_schedule: differs"))).toBe(true);
  });

  it("detects a missing table", () => {
    const db = getDb();
    db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE job_docs;`);
    expect(diffSchema(db)).toContain("table job_docs: missing");
    db.pragma("foreign_keys = ON");
  });
});

// ===========================================================================
// Foreign key enforcement + slug uniqueness at the DDL level
// ===========================================================================

describe("foreign keys", () => {
  // The raw INSERTs include a slug so the only constraint left to trip is the
  // FK — without it they'd "pass" on the slug NOT NULL instead.
  it("rejects an agent pointing at a non-existent project", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(`INSERT INTO agents (id, project_id, name, slug) VALUES ('a1', 'nope', 'X', 'x')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a run pointing at a non-existent job", () => {
    const { project } = hierarchy();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, project_id, job_id, status) VALUES ('r1', ?, 'nope', 'running')`,
        )
        .run(project.id),
    ).toThrow();
  });

  it("rejects resources pointing at a non-existent project", () => {
    const db = getDb();
    expect(() =>
      db.prepare(`INSERT INTO docs (id, project_id, title) VALUES ('d1', 'nope', 'X')`).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO env_vars (id, project_id, name, encrypted_value) VALUES ('e1', 'nope', 'X', 'v')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("enforces projects.slug uniqueness instance-wide via unique index", () => {
    createProject("Website");
    const db = getDb();
    expect(() =>
      db.prepare(`INSERT INTO projects (id, name, slug) VALUES ('p2', 'Other', 'website')`).run(),
    ).toThrow(/UNIQUE/);
  });
});

// ===========================================================================
// Cascades (hard delete)
// ===========================================================================

describe("cascade deletes", () => {
  it("deleting an agent cascades to its jobs and their runs (job.agent_id CASCADE)", () => {
    const { agent, job, run } = hierarchy();
    deleteAgent(agent.id);
    expect(getAgentById(agent.id)).toBeNull();
    expect(getJobById(job.id)).toBeNull();
    expect(getRunById(run.id)).toBeNull();
  });

  it("hard-deleting a project cascades to agents, jobs, runs, docs, env vars, and tables", () => {
    const { project, agent, job, run } = hierarchy();
    const doc = createDoc(project.id, "Doc", "body")!;
    const envVar = createEnvVar(project.id, "TOKEN", "v")!;
    const table = createTable(project.id, "leads", [{ name: "v", type: "TEXT" }]);
    const db = getDb();

    deleteProject(project.id);
    expect(getProjectById(project.id)).toBeNull();
    expect(getAgentById(agent.id)).toBeNull();
    expect(getJobById(job.id)).toBeNull();
    expect(getRunById(run.id)).toBeNull();
    expect(getDocById(doc.id)).toBeNull();
    expect(getEnvVarById(envVar.id)).toBeNull();
    expect(getTableById(table.id)).toBeNull();
    // resource tables that referenced the project are empty too
    for (const t of ["runs", "docs", "env_vars", "tables"]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).toMatchObject({ c: 0 });
    }
  });

  it("deleting a project removes cross-project link rows through the resource FK", () => {
    const { job } = hierarchy();
    const other = createProject("Other")!;
    const foreignDoc = createDoc(other.id, "Foreign", "f")!;
    const db = getDb();
    db.prepare(`INSERT INTO job_docs (job_id, doc_id) VALUES (?, ?)`).run(job.id, foreignDoc.id);

    deleteProject(other.id);
    // The doc cascaded away, and with it the link row on the surviving job.
    expect(
      db.prepare(`SELECT COUNT(*) c FROM job_docs WHERE job_id = ?`).get(job.id),
    ).toMatchObject({ c: 0 });
    expect(getJobById(job.id)).not.toBeNull();
  });

  it("deleting a user cascades to sessions", () => {
    const user = createUser("u@x.com", "pw", "U")!;
    createSession(user.id);
    const db = getDb();
    expect(db.prepare(`SELECT COUNT(*) c FROM sessions`).get()).toMatchObject({ c: 1 });
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    expect(db.prepare(`SELECT COUNT(*) c FROM sessions`).get()).toMatchObject({ c: 0 });
  });
});

// ===========================================================================
// Workflows and the runner registry
// ===========================================================================

describe("workflows", () => {
  it("creates workflows independently of agent jobs", () => {
    const project = createProject("Ops")!;
    const workflow = createWorkflow(project.id, {
      name: "Health Check",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "bash check.sh" },
    })!;
    expect(workflow.agent_id).toBeNull();
    expect(workflow.kind).toBe("workflow");
    expect(workflow.workflow_script).toBe("bash check.sh");
    expect(workflow.project_id).toBe(project.id);
  });

  it("registers a runner in the instance-level registry", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    expect(runner.tier).toBe("local");
    expect(runner.token).toMatch(/^hbrn_/);
  });
});
