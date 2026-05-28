import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import {
  createOrg,
  getOrgById,
  listOrgs,
  archiveOrg,
  unarchiveOrg,
  deleteOrg,
  addMembership,
  listMemberships,
  createProject,
  getProjectById,
  listProjects,
  archiveProject,
  deleteProject,
  createUser,
  createAgent,
  getAgentById,
  deleteAgent,
  createJob,
  createWorkflow,
  createWorkflowRunner,
  getJobById,
  createRun,
  getRunById,
} from "@/lib/db/queries";

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
// Foreign key enforcement
// ===========================================================================

describe("foreign keys", () => {
  it("rejects a project pointing at a non-existent org", () => {
    const db = getDb();
    expect(() =>
      db.prepare(`INSERT INTO projects (id, org_id, name) VALUES ('p1', 'nope', 'X')`).run()
    ).toThrow();
  });

  it("rejects an agent pointing at a non-existent project", () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(`INSERT INTO agents (id, project_id, name, api_key_hash) VALUES ('a1', 'nope', 'X', 'h')`)
        .run()
    ).toThrow();
  });

  it("rejects a run pointing at a non-existent job", () => {
    const { project } = hierarchy();
    const db = getDb();
    expect(() =>
      db
        .prepare(`INSERT INTO runs (id, project_id, job_id, status) VALUES ('r1', ?, 'nope', 'running')`)
        .run(project.id)
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
    const workflow = createWorkflow(project.id, {
      name: "Health Check",
      schedule: '{"every":60}',
      command: "bash check.sh",
    })!;
    expect(workflow.agent_id).toBeNull();
    expect(workflow.kind).toBe("workflow");
    expect(workflow.workflow_command).toBe("bash check.sh");
    expect(workflow.project_id).toBe(project.id);
  });

  it("creates workflow runner credentials scoped to an org", () => {
    const org = createOrg("Acme")!;
    const runner = createWorkflowRunner(org.id, "Server")!;
    expect(runner.org_id).toBe(org.id);
    expect(runner.apiKey).toMatch(/^hwf_/);
  });
});
