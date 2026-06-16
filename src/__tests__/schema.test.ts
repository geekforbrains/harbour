import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  archiveOrg,
  archiveProject,
  createAgent,
  createJob,
  createOrg,
  createProject,
  createRun,
  createRunner,
  createUser,
  createWorkflow,
  deleteAgent,
  deleteOrg,
  deleteProject,
  getAgentById,
  getJobById,
  getOrgById,
  getProjectById,
  getRunById,
  listMemberships,
  listOrgs,
  listProjects,
  unarchiveOrg,
} from "@/lib/db/queries";
import { diffSchema, getDb, initializeSchema, resetDb, setDb, verifySchema } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Setup / Teardown — fresh in-memory v2 DB per test
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
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Website")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  return { org, project, agent, job, run };
}

// ===========================================================================
// Schema shape + idempotency
// ===========================================================================

describe("v2 schema", () => {
  it("is idempotent under repeated initializeSchema calls", () => {
    const db = getDb();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();
    // orgs table exists exactly once
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'`)
      .all();
    expect(tables).toHaveLength(1);
  });

  it("creates the full org → project → agent → job → run hierarchy", () => {
    const { org, project, agent, job, run } = hierarchy();
    expect(org.id).toBeDefined();
    expect(project.org_id).toBe(org.id);
    expect(agent.project_id).toBe(project.id);
    expect(job.project_id).toBe(project.id);
    expect(job.agent_id).toBe(agent.id);
    expect(run.project_id).toBe(project.id); // denormalized from the job
    expect(run.job_id).toBe(job.id);
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

  it("ignores agent-managed d_* data tables", () => {
    const db = getDb();
    db.exec(`CREATE TABLE d_proj_leads_abc123 (id INTEGER PRIMARY KEY, email TEXT)`);
    expect(diffSchema(db)).toEqual([]);
  });

  it("detects a missing column left behind by CREATE TABLE IF NOT EXISTS", () => {
    const db = getDb();
    db.exec(`ALTER TABLE jobs DROP COLUMN prerun_script`);
    const drift = diffSchema(db);
    expect(drift).toContain("table jobs: missing column prerun_script (TEXT)");
    expect(() => verifySchema(db)).toThrow(/jobs: missing column prerun_script/);
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
// Foreign key enforcement
// ===========================================================================

describe("foreign keys", () => {
  // The raw INSERTs include a slug so the only constraint left to trip is the
  // FK — without it they'd "pass" on the slug NOT NULL instead.
  it("rejects a project pointing at a non-existent org", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(`INSERT INTO projects (id, org_id, name, slug) VALUES ('p1', 'nope', 'X', 'x')`)
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects an agent pointing at a non-existent project", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (id, project_id, name, slug, api_key_hash) VALUES ('a1', 'nope', 'X', 'x', 'h')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a run pointing at a non-existent job", () => {
    const { org, project } = hierarchy();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, org_id, project_id, job_id, status) VALUES ('r1', ?, ?, 'nope', 'running')`,
        )
        .run(org.id, project.id),
    ).toThrow();
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

  it("hard-deleting a project cascades to agents, jobs, and runs", () => {
    const { project, agent, job, run } = hierarchy();
    const db = getDb();
    deleteProject(project.id);
    expect(getProjectById(project.id)).toBeNull();
    expect(getAgentById(agent.id)).toBeNull();
    expect(getJobById(job.id)).toBeNull();
    expect(getRunById(run.id)).toBeNull();
    // resource tables that referenced the project are gone too
    expect(db.prepare(`SELECT COUNT(*) c FROM runs`).get()).toMatchObject({ c: 0 });
  });

  it("hard-deleting an org cascades through projects to everything beneath", () => {
    const { org, project, agent, job, run } = hierarchy();
    deleteOrg(org.id);
    expect(getOrgById(org.id)).toBeNull();
    expect(getProjectById(project.id)).toBeNull();
    expect(getAgentById(agent.id)).toBeNull();
    expect(getJobById(job.id)).toBeNull();
    expect(getRunById(run.id)).toBeNull();
  });

  it("deleting a user cascades to memberships", () => {
    const org = createOrg("Acme")!;
    const user = createUser("u@x.com", "pw", "U")!;
    addMembership(user.id, org.id, "editor");
    expect(listMemberships(org.id)).toHaveLength(1);
    getDb().prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
    expect(listMemberships(org.id)).toHaveLength(0);
  });
});

// ===========================================================================
// Soft delete (archive) leaves rows intact
// ===========================================================================

describe("soft delete (archive)", () => {
  it("archiving an org hides it from listOrgs but preserves the row and children", () => {
    const { org, project, run } = hierarchy();
    archiveOrg(org.id);

    // Row still exists
    const archived = getOrgById(org.id);
    expect(archived).not.toBeNull();
    expect(archived.archived_at).not.toBeNull();

    // Hidden from default list, visible with includeArchived
    expect(listOrgs()).toHaveLength(0);
    expect(listOrgs({ includeArchived: true })).toHaveLength(1);

    // Children untouched
    expect(getProjectById(project.id)).not.toBeNull();
    expect(getRunById(run.id)).not.toBeNull();

    // Restorable
    unarchiveOrg(org.id);
    expect(listOrgs()).toHaveLength(1);
  });

  it("archiving a project hides it from listProjects but preserves the row and children", () => {
    const { org, project, agent, job } = hierarchy();
    archiveProject(project.id);

    const archived = getProjectById(project.id);
    expect(archived).not.toBeNull();
    expect(archived.archived_at).not.toBeNull();

    expect(listProjects(org.id)).toHaveLength(0);
    expect(listProjects(org.id, { includeArchived: true })).toHaveLength(1);

    // Children untouched (archive is not a delete)
    expect(getAgentById(agent.id)).not.toBeNull();
    expect(getJobById(job.id)).not.toBeNull();
  });
});

// ===========================================================================
// Workflows and workflow runners
// ===========================================================================

describe("workflows", () => {
  it("creates workflows independently of agent jobs", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Ops")!;
    const workflow = createWorkflow(org.id, project.id, {
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
