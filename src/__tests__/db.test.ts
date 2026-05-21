import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import { getNextRunTime, normalizeSchedule } from "@/lib/schedule";
import {
  createUser,
  authenticateUser,
  listUsers,
  createAgent,
  authenticateAgent,
  rotateAgentKey,
  listAgents,
  updateAgent,
  getAgentById,
  deleteAgent,
  touchAgentPolled,
  createJob,
  getJobById,
  listJobsByAgent,
  listAllJobs,
  updateJob,
  deleteJob,
  linkDocToJob,
  unlinkDocFromJob,
  createRun,
  getRunById,
  getRunWithActivity,
  updateRunStatus,
  listRunsByJob,
  listRunsByAgent,
  listWaitingRuns,
  listRecentRuns,
  addRunActivity,
  listRunActivity,
  getAgentNextRun,
  peekAgentNext,
  createDoc,
  getDocById,
  updateDoc,
  renameDoc,
  deleteDoc,
  listDocs,
  getDocRevisions,
  createDatabase,
  getDatabaseById,
  getDatabaseByName,
  listDatabases,
  deleteDatabase,
  addColumn,
  getRows,
  insertRows,
  updateRow,
  deleteRow,
  linkDatabaseToJob,
  unlinkDatabaseFromJob,
  triggerJobRun,
  listScheduledRuns,
  listRunningRuns,
  listWorkspaces,
  createWorkspace,
  listProjects,
  createProject,
  getProjectById,
  createEnvVar,
  listEnvVars,
  upsertCredentialProfile,
  getCredentialProfileByEmail,
  upsertProviderCredential,
  listProviderCredentials,
  getCredentialBrokerEnvForProfile,
  runHasCredentialProfile,
  WorkspaceConflictError,
  linkAgentToProject,
  linkJobToProject,
  linkDocToProject,
  linkEnvVarToProject,
  linkDatabaseToProject,
  addRunOutput,
  listRunOutput,
} from "@/lib/db/queries";
import { isVisualArtifactMime } from "@/lib/redaction";

type WorkspaceRow = { id: string };
type ProjectRow = { id: string; workspace_id: string | null };
type NamedRow = { id: string; name: string };
type TitledRow = { id: string; title: string };
type RunRow = { id: string; job_name: string };
type OutputRow = { content: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function seedAgent(name = "test-bot") {
  return createAgent(name, `${name} description`);
}

function seedJob(agentId: string, name = "Test Job") {
  return createJob(agentId, { name, schedule: '{"every":60}' });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  const db = freshDb();
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
});

// ===========================================================================
// Workspace / Project Management
// ===========================================================================

describe("Workspace / Project Management", () => {
  it("seeds BORG Interface workspaces", () => {
    const workspaces = listWorkspaces() as WorkspaceRow[];
    expect(workspaces.map(w => w.id)).toContain("borg-interface");
    expect(workspaces.map(w => w.id)).toContain("agent-research");
    expect(workspaces.map(w => w.id)).toContain("cultr-ventures");
    expect(workspaces.map(w => w.id)).toContain("phaseone");
  });

  it("creates projects inside a workspace", () => {
    const workspace = createWorkspace({ name: "Test Workspace" }) as WorkspaceRow;
    const project = createProject("Nested Project", workspace.id) as ProjectRow;
    expect(project.workspace_id).toBe(workspace.id);
    const projects = listProjects(workspace.id) as ProjectRow[];
    expect(projects.map(p => p.id)).toContain(project.id);
  });

  it("rejects duplicate workspace slugs cleanly", () => {
    createWorkspace({ name: "Duplicate Workspace" });
    expect(() => createWorkspace({ name: "Duplicate Workspace" })).toThrow(WorkspaceConflictError);
  });

  it("does not reassign intentionally null workspace ownership on later schema init", () => {
    const workspace = createWorkspace({ name: "Temporary Workspace" }) as WorkspaceRow;
    const project = createProject("Temporary Project", workspace.id) as ProjectRow;

    getDb().prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspace.id);
    expect((getProjectById(project.id) as ProjectRow).workspace_id).toBeNull();

    initializeSchema(getDb());
    expect((getProjectById(project.id) as ProjectRow).workspace_id).toBeNull();
  });

  it("filters linked records by workspace through projects", () => {
    const alphaWorkspace = createWorkspace({ name: "Alpha Workspace" }) as WorkspaceRow;
    const betaWorkspace = createWorkspace({ name: "Beta Workspace" }) as WorkspaceRow;
    const alphaProject = createProject("Alpha Project", alphaWorkspace.id) as ProjectRow;
    const betaProject = createProject("Beta Project", betaWorkspace.id) as ProjectRow;

    const alphaAgent = createAgent("alpha-agent", undefined, { scopeType: "project", projectId: alphaProject.id });
    const betaAgent = createAgent("beta-agent", undefined, { scopeType: "project", projectId: betaProject.id });
    linkAgentToProject(alphaProject.id, alphaAgent.id);
    linkAgentToProject(betaProject.id, betaAgent.id);

    const alphaJob = createJob(alphaAgent.id, { name: "alpha-job", schedule: "{\"every\":60}" })!;
    const betaJob = createJob(betaAgent.id, { name: "beta-job", schedule: "{\"every\":60}" })!;
    linkJobToProject(alphaProject.id, alphaJob.id);
    linkJobToProject(betaProject.id, betaJob.id);

    const alphaRun = createRun(alphaJob.id, alphaAgent.id)!;
    const betaRun = createRun(betaJob.id, betaAgent.id)!;
    updateRunStatus(alphaRun.id, "waiting");
    updateRunStatus(betaRun.id, "waiting");

    const alphaDoc = createDoc("alpha-doc")!;
    const betaDoc = createDoc("beta-doc")!;
    linkDocToProject(alphaProject.id, alphaDoc.id);
    linkDocToProject(betaProject.id, betaDoc.id);

    const alphaEnv = createEnvVar("ALPHA_TOKEN", "secret")!;
    const betaEnv = createEnvVar("BETA_TOKEN", "secret")!;
    linkEnvVarToProject(alphaProject.id, alphaEnv.id);
    linkEnvVarToProject(betaProject.id, betaEnv.id);

    const alphaDb = createDatabase("alpha_db", [{ name: "value", type: "TEXT" }])!;
    const betaDb = createDatabase("beta_db", [{ name: "value", type: "TEXT" }])!;
    linkDatabaseToProject(alphaProject.id, alphaDb.id);
    linkDatabaseToProject(betaProject.id, betaDb.id);

    expect((listAgents(undefined, alphaWorkspace.id) as NamedRow[]).map(r => r.name)).toEqual(["alpha-agent"]);
    expect((listAllJobs(undefined, alphaWorkspace.id) as NamedRow[]).map(r => r.name)).toEqual(["alpha-job"]);
    expect((listWaitingRuns(undefined, alphaWorkspace.id) as RunRow[]).map(r => r.job_name)).toEqual(["alpha-job"]);
    expect((listDocs(undefined, alphaWorkspace.id) as TitledRow[]).map(r => r.title)).toEqual(["alpha-doc"]);
    expect((listEnvVars(undefined, alphaWorkspace.id) as NamedRow[]).map(r => r.name)).toEqual(["ALPHA_TOKEN"]);
    expect((listDatabases(undefined, alphaWorkspace.id) as NamedRow[]).map(r => r.name)).toEqual(["alpha_db"]);
  });
});

// ===========================================================================
// Credential Profiles / Secret Broker
// ===========================================================================

describe("Credential Profiles / Secret Broker", () => {
  it("stores the same canonical env name for separate people without env var collisions", () => {
    const alice = upsertCredentialProfile({ email: "Alice@Example.com", displayName: "Alice" })!;
    const bob = upsertCredentialProfile({ email: "bob@example.com", displayName: "Bob" })!;

    upsertProviderCredential({
      profileId: alice.id,
      provider: "google-ai-studio",
      envName: "GOOGLE_API_KEY",
      value: "alice-google-secret-123456",
      accountEmail: "alice@example.com",
    });
    upsertProviderCredential({
      profileId: bob.id,
      provider: "google-ai-studio",
      envName: "GOOGLE_API_KEY",
      value: "bob-google-secret-abcdef",
      accountEmail: "bob@example.com",
    });

    expect(getCredentialProfileByEmail("alice@example.com")!.id).toBe(alice.id);
    expect(listProviderCredentials(alice.id).map((c: any) => c.env_name)).toEqual(["GOOGLE_API_KEY"]);
    expect(getCredentialBrokerEnvForProfile(alice.id).GOOGLE_API_KEY).toBe("alice-google-secret-123456");
    expect(getCredentialBrokerEnvForProfile(bob.id).GOOGLE_API_KEY).toBe("bob-google-secret-abcdef");

    const envNames = (listEnvVars() as NamedRow[]).map(row => row.name);
    expect(envNames).not.toContain("GOOGLE_API_KEY");
    expect(new Set(envNames).size).toBe(envNames.length);
  });

  it("does not expose secret values in credential profile records", () => {
    const profile = upsertCredentialProfile({ email: "record-view@example.com" })!;
    upsertProviderCredential({
      profileId: profile.id,
      provider: "cerebras",
      envName: "CEREBRAS_API_KEY",
      value: "csk-record-view-secret-123456",
    });

    const records = listProviderCredentials(profile.id);
    expect(JSON.stringify(records)).not.toContain("csk-record-view-secret-123456");
    expect(records[0].env_name).toBe("CEREBRAS_API_KEY");
  });

  it("injects a job credential profile through the broker using canonical names", () => {
    const profile = upsertCredentialProfile({ email: "provisionee@example.com" })!;
    upsertProviderCredential({
      profileId: profile.id,
      provider: "openrouter",
      envName: "OPENROUTER_API_KEY",
      value: "sk-or-v1-profile-secret",
    });

    const agent = createAgent("profile-broker", undefined, { type: "harbour", cli: "openclaw" });
    const job = createJob(agent.id, {
      name: "Profile Key Check",
      schedule: '{"every":60}',
      credentialProfileId: profile.id,
    })!;
    updateJob(job.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const payload = getAgentNextRun(agent.id)!;
    expect(payload.env.OPENROUTER_API_KEY).toBe("sk-or-v1-profile-secret");
    expect(payload.job.credential_profile_id).toBe(profile.id);
  });

  it("rejects non-canonical provider env names", () => {
    const profile = upsertCredentialProfile({ email: "invalid-env@example.com" })!;
    expect(() => upsertProviderCredential({
      profileId: profile.id,
      provider: "openrouter",
      envName: "GOOGLE_API_KEY",
      value: "wrong-provider-secret",
    })).toThrow(/not valid for provider openrouter/);
    expect(() => upsertProviderCredential({
      profileId: profile.id,
      provider: "unknown-provider",
      envName: "UNKNOWN_API_KEY",
      value: "unknown-provider-secret",
    })).toThrow(/unsupported provider/);
  });

  it("redacts linked env var and profile broker secrets from activity and output", () => {
    const agent = seedAgent("redactor");
    const profile = upsertCredentialProfile({ email: "redact@example.com" })!;
    upsertProviderCredential({
      profileId: profile.id,
      provider: "openrouter",
      envName: "OPENROUTER_API_KEY",
      value: "sk-or-v1-redact-profile-secret",
    });
    const linked = createEnvVar("LINKED_SECRET", "linked-secret-value-123")!;
    const job = createJob(agent.id, {
      name: "Redaction Check",
      schedule: '{"every":60}',
      envVarIds: [linked.id],
      credentialProfileId: profile.id,
    })!;
    const run = createRun(job.id, agent.id)!;

    addRunActivity(
      run.id,
      "agent",
      agent.id,
      agent.name,
      "linked-secret-value-123 and sk-or-v1-redact-profile-secret should not be stored",
    );
    addRunOutput(run.id, [{
      event_type: "text_delta",
      content: "stream saw linked-secret-value-123 and sk-or-v1-redact-profile-secret",
      tool_name: null,
    }]);

    const activity = listRunActivity(run.id);
    expect(activity[0].content).not.toContain("linked-secret-value-123");
    expect(activity[0].content).not.toContain("sk-or-v1-redact-profile-secret");
    expect(activity[0].content).toContain("[REDACTED_SECRET]");

    const output = listRunOutput(run.id) as OutputRow[];
    expect(output[0].content).not.toContain("linked-secret-value-123");
    expect(output[0].content).not.toContain("sk-or-v1-redact-profile-secret");
    expect(output[0].content).toContain("[REDACTED_SECRET]");
  });

  it("marks credential-profile runs for visual artifact quarantine", () => {
    const agent = seedAgent("visual-quarantine");
    const profile = upsertCredentialProfile({ email: "visual@example.com" })!;
    const sensitiveJob = createJob(agent.id, {
      name: "Sensitive Visual Guard",
      schedule: '{"every":60}',
      credentialProfileId: profile.id,
    })!;
    const normalJob = createJob(agent.id, {
      name: "Normal Visual Guard",
      schedule: '{"every":60}',
    })!;
    const sensitiveRun = createRun(sensitiveJob.id, agent.id)!;
    const normalRun = createRun(normalJob.id, agent.id)!;

    expect(runHasCredentialProfile(sensitiveRun.id)).toBe(true);
    expect(runHasCredentialProfile(normalRun.id)).toBe(false);
    expect(isVisualArtifactMime("image/png")).toBe(true);
    expect(isVisualArtifactMime("video/mp4")).toBe(true);
    expect(isVisualArtifactMime("application/pdf")).toBe(true);
    expect(isVisualArtifactMime("text/plain")).toBe(false);
  });
});

// ===========================================================================
// User Management
// ===========================================================================

describe("User Management", () => {
  it("should create a user", () => {
    const user = createUser("alice@example.com", "password123", "Alice");
    expect(user).toBeDefined();
    expect(user!.id).toBeDefined();
    expect(user!.email).toBe("alice@example.com");
    expect(user!.display_name).toBe("Alice");
  });

  it("should authenticate with correct password", () => {
    createUser("bob@example.com", "secret", "Bob");
    const result = authenticateUser("bob@example.com", "secret");
    expect(result).not.toBeNull();
    expect(result!.email).toBe("bob@example.com");
  });

  it("should reject wrong password", () => {
    createUser("bob@example.com", "secret", "Bob");
    expect(authenticateUser("bob@example.com", "wrong")).toBeNull();
  });

  it("should reject non-existent user", () => {
    expect(authenticateUser("ghost@example.com", "nope")).toBeNull();
  });

  it("should list users ordered by email", () => {
    createUser("zara@example.com", "pw", "Zara");
    createUser("alice@example.com", "pw", "Alice");
    const users = listUsers();
    expect(users).toHaveLength(2);
    expect((users[0] as any).email).toBe("alice@example.com");
  });
});

// ===========================================================================
// Agent Management
// ===========================================================================

describe("Agent Management", () => {
  it("should create an agent with an API key", () => {
    const agent = seedAgent();
    expect(agent.id).toBeDefined();
    expect(agent.name).toBe("test-bot");
    expect(agent.apiKey).toMatch(/^hbr_/);
  });

  it("should authenticate with API key", () => {
    const { apiKey } = seedAgent();
    const found = authenticateAgent(apiKey);
    expect(found).not.toBeNull();
    expect(found.name).toBe("test-bot");
  });

  it("should reject invalid API key", () => {
    seedAgent();
    expect(authenticateAgent("hbr_invalid")).toBeNull();
  });

  it("should rotate an agent key", () => {
    const { id, apiKey: oldKey } = seedAgent();
    const newKey = rotateAgentKey(id);
    expect(newKey).toMatch(/^hbr_/);
    expect(newKey).not.toBe(oldKey);
    expect(authenticateAgent(oldKey)).toBeNull();
    expect(authenticateAgent(newKey)).not.toBeNull();
  });

  it("should list agents with counts", () => {
    seedAgent("zeta-bot");
    seedAgent("alpha-bot");
    const agents = listAgents();
    expect(agents).toHaveLength(2);
    expect((agents[0] as any).name).toBe("alpha-bot");
    expect((agents[0] as any).job_count).toBe(0);
    expect((agents[0] as any).waiting_count).toBe(0);
    expect((agents[0] as any).pending_count).toBe(0);
  });

  it("should update an agent", () => {
    const { id } = seedAgent();
    const updated = updateAgent(id, { name: "new-name", description: "new desc" });
    expect(updated.name).toBe("new-name");
    expect(updated.description).toBe("new desc");
  });

  it("should delete an agent", () => {
    const { id } = seedAgent();
    deleteAgent(id);
    expect(getAgentById(id)).toBeNull();
  });

  it("should track last_polled_at", () => {
    const { id } = seedAgent();
    expect(getAgentById(id).last_polled_at).toBeNull();
    touchAgentPolled(id);
    expect(getAgentById(id).last_polled_at).not.toBeNull();
  });

  it("should default eager to false on create", () => {
    const agent = createAgent("e1", undefined, { type: "harbour", cli: "claude-code" });
    expect(agent.eager).toBe(false);
    expect(getAgentById(agent.id).eager).toBe(0);
  });

  it("should create a harbour agent with eager=true", () => {
    const agent = createAgent("e2", undefined, { type: "harbour", cli: "claude-code", eager: true });
    expect(agent.eager).toBe(true);
    expect(getAgentById(agent.id).eager).toBe(1);
  });

  it("should toggle eager on update", () => {
    const { id } = createAgent("e3", undefined, { type: "harbour", cli: "claude-code" });
    expect(getAgentById(id).eager).toBe(0);
    updateAgent(id, { eager: true });
    expect(getAgentById(id).eager).toBe(1);
    updateAgent(id, { eager: false });
    expect(getAgentById(id).eager).toBe(0);
  });

  it("should preserve eager when other fields are updated", () => {
    const { id } = createAgent("e4", undefined, { type: "harbour", cli: "claude-code", eager: true });
    updateAgent(id, { name: "renamed" });
    const after = getAgentById(id);
    expect(after.name).toBe("renamed");
    expect(after.eager).toBe(1);
  });

  it("should expose eager in listAgents", () => {
    createAgent("e5", undefined, { type: "harbour", cli: "claude-code", eager: true });
    const list = listAgents();
    const e5 = list.find((a: any) => a.name === "e5") as any;
    expect(e5).toBeDefined();
    expect(e5.eager).toBe(1);
  });

  it("should be idempotent under repeated initializeSchema calls", () => {
    // Re-running initializeSchema should not re-add the eager column or fail
    const db = getDb();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(agents)`).all() as any[];
    const eagerCols = cols.filter(c => c.name === "eager");
    expect(eagerCols).toHaveLength(1);
    expect(eagerCols[0].dflt_value).toBe("0");
  });
});

// ===========================================================================
// Job Management
// ===========================================================================

describe("Job Management", () => {
  let agentId: string;

  beforeEach(() => {
    agentId = seedAgent().id;
  });

  it("should create a job", () => {
    const job = seedJob(agentId);
    expect(job).toBeDefined();
    expect(job!.name).toBe("Test Job");
    expect(job!.agent_id).toBe(agentId);
    expect(job!.schedule).toBe('{"every":60}');
  });

  it("should create a job with all fields", () => {
    const job = createJob(agentId, {
      name: "Full Job",
      description: "Does everything",
      instructions: "Step 1: do the thing",
      schedule: '{"days":[1,2,3],"time":"09:00"}',
      workflowCommand: "python3 check.py",
    });
    expect(job!.description).toBe("Does everything");
    expect(job!.instructions).toBe("Step 1: do the thing");
    expect(job!.workflow_command).toBe("python3 check.py");
    expect(job!.workflow_only).toBe(0);
  });

  it("should create a workflow-only job", () => {
    const job = createJob(agentId, {
      name: "Workflow Job",
      schedule: '{"every":60}',
      workflowCommand: "bash health_check.sh",
      workflowOnly: true,
    });
    expect(job!.workflow_command).toBe("bash health_check.sh");
    expect(job!.workflow_only).toBe(1);
  });

  it("should list jobs by agent with run counts", () => {
    seedJob(agentId, "Job A");
    seedJob(agentId, "Job B");
    const jobs = listJobsByAgent(agentId);
    expect(jobs).toHaveLength(2);
    expect((jobs[0] as any).total_runs).toBe(0);
    expect((jobs[0] as any).waiting_runs).toBe(0);
    expect((jobs[0] as any).pending_runs).toBe(0);
  });

  it("should list all jobs across agents", () => {
    const agent2 = seedAgent("other-bot").id;
    seedJob(agentId, "Job A");
    seedJob(agent2, "Job B");
    const jobs = listAllJobs();
    expect(jobs).toHaveLength(2);
    expect((jobs[0] as any).agent_name).toBeDefined();
  });

  it("should update a job", () => {
    const job = seedJob(agentId);
    const updated = updateJob(job!.id, { name: "Updated", active: false });
    expect(updated!.name).toBe("Updated");
    expect(updated!.active).toBe(0);
  });

  it("should delete a job", () => {
    const job = seedJob(agentId);
    deleteJob(job!.id);
    expect(getJobById(job!.id)).toBeNull();
  });
});

// ===========================================================================
// Run Lifecycle
// ===========================================================================

describe("Run Lifecycle", () => {
  let agentId: string;
  let jobId: string;

  beforeEach(() => {
    agentId = seedAgent().id;
    jobId = seedJob(agentId)!.id;
  });

  it("should create a run in running status", () => {
    const run = createRun(jobId, agentId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("running");
    expect(run!.job_name).toBe("Test Job");
  });

  it("should get a run with activity", () => {
    const run = createRun(jobId, agentId);
    addRunActivity(run!.id, "agent", agentId, "test-bot", "Working on it...");
    const full = getRunWithActivity(run!.id);
    expect(full).not.toBeNull();
    expect(full!.activity).toHaveLength(1);
    expect(full!.activity[0].content).toBe("Working on it...");
  });

  it("should transition through statuses", () => {
    const run = createRun(jobId, agentId);

    // running → waiting
    const waiting = updateRunStatus(run!.id, "waiting");
    expect(waiting!.status).toBe("waiting");
    expect(waiting!.completed_at).toBeNull();

    // waiting → pending
    const pending = updateRunStatus(run!.id, "pending");
    expect(pending!.status).toBe("pending");

    // pending → running (agent resumes)
    const resumed = updateRunStatus(run!.id, "running");
    expect(resumed!.status).toBe("running");

    // running → done
    const done = updateRunStatus(run!.id, "done");
    expect(done!.status).toBe("done");
    expect(done!.completed_at).not.toBeNull();
  });

  it("should list runs by job", () => {
    createRun(jobId, agentId);
    createRun(jobId, agentId);
    const runs = listRunsByJob(jobId);
    expect(runs).toHaveLength(2);
  });

  it("should list runs by agent", () => {
    createRun(jobId, agentId);
    const runs = listRunsByAgent(agentId);
    expect(runs).toHaveLength(1);
  });

  it("should list waiting and pending runs", () => {
    const run1 = createRun(jobId, agentId);
    updateRunStatus(run1!.id, "waiting");
    const run2 = createRun(jobId, agentId);
    updateRunStatus(run2!.id, "pending");
    const waiting = listWaitingRuns();
    expect(waiting).toHaveLength(2);
  });

  it("should list recent completed runs", () => {
    const run = createRun(jobId, agentId);
    updateRunStatus(run!.id, "done");
    const recent = listRecentRuns();
    expect(recent).toHaveLength(1);
  });
});

// ===========================================================================
// Activity Log
// ===========================================================================

describe("Activity Log", () => {
  it("should add and list activity", () => {
    const agentId = seedAgent().id;
    const jobId = seedJob(agentId)!.id;
    const run = createRun(jobId, agentId);

    addRunActivity(run!.id, "agent", agentId, "test-bot", "Started working");
    addRunActivity(run!.id, "user", "user-1", "Alice", "Please also check X");
    addRunActivity(run!.id, "system", null, "System", "Status changed to waiting");

    const activity = listRunActivity(run!.id);
    expect(activity).toHaveLength(3);
    expect((activity[0] as any).author_type).toBe("agent");
    expect((activity[1] as any).author_type).toBe("user");
    expect((activity[2] as any).author_type).toBe("system");
  });
});

// ===========================================================================
// Agent Polling (/next)
// ===========================================================================

describe("Agent Polling", () => {
  let agentId: string;

  beforeEach(() => {
    agentId = seedAgent().id;
  });

  it("should return null when no jobs exist", () => {
    expect(getAgentNextRun(agentId)).toBeNull();
  });

  it("should return null when agent has a running run", () => {
    const jobId = seedJob(agentId)!.id;
    createRun(jobId, agentId); // creates in "running" status
    expect(getAgentNextRun(agentId)).toBeNull();
  });

  it("should pick up pending runs (human responded)", () => {
    const jobId = seedJob(agentId)!.id;
    const run = createRun(jobId, agentId);
    updateRunStatus(run!.id, "waiting");
    updateRunStatus(run!.id, "pending");

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.run.status).toBe("running"); // transitioned from pending
    expect(payload!.job.name).toBe("Test Job");
  });

  it("should create a run when a scheduled job is ready", () => {
    const job = createJob(agentId, { name: "Scheduled", schedule: '{"every":60}' });
    // Set next_run_at to the past so it's ready
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.job.name).toBe("Scheduled");
    expect(payload!.run.status).toBe("running");
  });

  it("should not create a run for future-scheduled jobs", () => {
    const job = createJob(agentId, { name: "Future", schedule: '{"every":60}' });
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) + 3600 });

    expect(getAgentNextRun(agentId)).toBeNull();
  });

  it("should prioritize pending over scheduled", () => {
    const job1 = createJob(agentId, { name: "Old Job", schedule: '{"every":60}' });
    updateJob(job1!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const job2 = createJob(agentId, { name: "Pending Job", schedule: '{"every":120}' });
    const run = createRun(job2!.id, agentId);
    updateRunStatus(run!.id, "waiting");
    updateRunStatus(run!.id, "pending");

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.job.name).toBe("Pending Job");
  });

  it("peek should show available work without claiming", () => {
    const job = createJob(agentId, { name: "Peekable", schedule: '{"every":60}' });
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const peeked = peekAgentNext(agentId);
    expect(peeked.available).toBe(true);
    expect(peeked.job_name).toBe("Peekable");

    // No run should have been created
    const runs = listRunsByAgent(agentId);
    expect(runs).toHaveLength(0);
  });

  it("peek should report busy when agent has running run", () => {
    const jobId = seedJob(agentId)!.id;
    createRun(jobId, agentId);

    const peeked = peekAgentNext(agentId);
    expect(peeked.available).toBe(false);
    expect(peeked.reason).toBe("busy");
  });
});

// ===========================================================================
// Docs
// ===========================================================================

describe("Docs", () => {
  it("should create a doc", () => {
    const doc = createDoc("README");
    expect(doc).toBeDefined();
    expect(doc!.title).toBe("README");
    expect(doc!.content).toBe("");
  });

  it("should create a doc with content", () => {
    const doc = createDoc("Guide", "# Hello World", "user", "u1");
    expect(doc!.content).toBe("# Hello World");
  });

  it("should update a doc (creates revision)", () => {
    const doc = createDoc("Notes", "v1", "user", "u1");
    updateDoc(doc!.id, "v2", "user", "u1");

    const revisions = getDocRevisions(doc!.id);
    expect(revisions).toHaveLength(2);
    const contents = (revisions as any[]).map(r => r.content).sort();
    expect(contents).toEqual(["v1", "v2"]);
  });

  it("should rename a doc", () => {
    const doc = createDoc("Old Title");
    renameDoc(doc!.id, "New Title");
    const updated = getDocById(doc!.id);
    expect(updated!.title).toBe("New Title");
  });

  it("should delete a doc", () => {
    const doc = createDoc("To Delete");
    deleteDoc(doc!.id);
    expect(getDocById(doc!.id)).toBeNull();
  });

  it("should list docs ordered by title", () => {
    createDoc("Zebra");
    createDoc("Alpha");
    const docs = listDocs();
    expect(docs).toHaveLength(2);
    expect((docs[0] as any).title).toBe("Alpha");
  });

  it("should link docs to jobs", () => {
    const agentId = seedAgent().id;
    const job = seedJob(agentId);
    const doc = createDoc("Spec", "content", "user", "u1");
    linkDocToJob(job!.id, doc!.id);

    const loaded = getJobById(job!.id);
    expect(loaded!.docs).toHaveLength(1);
    expect(loaded!.docs[0].title).toBe("Spec");

    unlinkDocFromJob(job!.id, doc!.id);
    const unlinked = getJobById(job!.id);
    expect(unlinked!.docs).toHaveLength(0);
  });
});

// ===========================================================================
// Databases
// ===========================================================================

describe("Databases", () => {
  it("should create a database with columns", () => {
    const db = createDatabase("tweets", [
      { name: "text", type: "TEXT", required: true },
      { name: "likes", type: "INTEGER" },
    ]);
    expect(db.name).toBe("tweets");
    expect(db.table_name).toBe("d_tweets");
    expect(db.columns).toHaveLength(2);
  });

  it("should find by name", () => {
    createDatabase("metrics", [{ name: "value", type: "REAL" }]);
    const found = getDatabaseByName("metrics");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("metrics");
  });

  it("should insert and read rows", () => {
    const db = createDatabase("logs", [
      { name: "message", type: "TEXT" },
      { name: "level", type: "TEXT" },
    ]);

    insertRows(db.id, [
      { message: "hello", level: "info" },
      { message: "error!", level: "error" },
    ]);

    const result = getRows(db.id);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.total).toBe(2);
  });

  it("should update a row", () => {
    const db = createDatabase("items", [{ name: "name", type: "TEXT" }]);
    insertRows(db.id, [{ name: "old" }]);

    const rows = getRows(db.id)!.rows;
    updateRow(db.id, (rows[0] as any)._id, { name: "new" });

    const updated = getRows(db.id)!.rows;
    expect((updated[0] as any).name).toBe("new");
  });

  it("should delete a row", () => {
    const db = createDatabase("tempdata", [{ name: "val", type: "TEXT" }]);
    insertRows(db.id, [{ val: "a" }, { val: "b" }]);

    const rows = getRows(db.id)!.rows;
    deleteRow(db.id, (rows[0] as any)._id);

    expect(getRows(db.id)!.total).toBe(1);
  });

  it("should add a column", () => {
    const db = createDatabase("evolving", [{ name: "name", type: "TEXT" }]);
    addColumn(db.id, { name: "age", type: "INTEGER", default: 0, required: true });

    const updated = getDatabaseById(db.id);
    expect(updated!.columns).toHaveLength(2);
    expect(updated!.columns[1].name).toBe("age");
  });

  it("should paginate rows", () => {
    const db = createDatabase("big", [{ name: "num", type: "INTEGER" }]);
    const rows = Array.from({ length: 10 }, (_, i) => ({ num: i }));
    insertRows(db.id, rows);

    const page1 = getRows(db.id, { limit: 3, offset: 0 });
    expect(page1!.rows).toHaveLength(3);
    expect(page1!.total).toBe(10);

    const page2 = getRows(db.id, { limit: 3, offset: 3 });
    expect(page2!.rows).toHaveLength(3);
  });

  it("should list databases with row counts and linked jobs", () => {
    const agentId = seedAgent().id;
    const job = seedJob(agentId);
    const db = createDatabase("linked", [{ name: "val", type: "TEXT" }]);
    linkDatabaseToJob(job!.id, db.id);
    insertRows(db.id, [{ val: "x" }]);

    const list = listDatabases();
    expect(list).toHaveLength(1);
    expect(list[0].row_count).toBe(1);
    expect(list[0].jobs).toHaveLength(1);
    expect(list[0].jobs[0].name).toBe("Test Job");
  });

  it("should delete a database and its table", () => {
    const db = createDatabase("deletable", [{ name: "x", type: "TEXT" }]);
    insertRows(db.id, [{ x: "y" }]);
    deleteDatabase(db.id);
    expect(getDatabaseById(db.id)).toBeNull();
  });

  it("should link and unlink databases from jobs", () => {
    const agentId = seedAgent().id;
    const job = seedJob(agentId);
    const db = createDatabase("linktest", [{ name: "v", type: "TEXT" }]);

    linkDatabaseToJob(job!.id, db.id);
    const linked = getJobById(job!.id);
    expect(linked!.databases).toHaveLength(1);

    unlinkDatabaseFromJob(job!.id, db.id);
    const unlinked = getJobById(job!.id);
    expect(unlinked!.databases).toHaveLength(0);
  });
});

// ===========================================================================
// Schedule Normalization
// ===========================================================================

describe("Schedule Normalization", () => {
  it("should pass through canonical interval JSON", () => {
    expect(normalizeSchedule('{"every":5}')).toBe('{"every":5}');
  });

  it("should pass through canonical weekly JSON", () => {
    expect(normalizeSchedule('{"days":[1,2,3],"time":"09:00"}')).toBe('{"days":[1,2,3],"time":"09:00"}');
  });

  it("should normalize human-readable interval", () => {
    expect(normalizeSchedule("every 5 minutes")).toBe('{"every":5}');
  });

  it("should normalize human-readable hours", () => {
    expect(normalizeSchedule("every 2 hours")).toBe('{"every":120}');
  });

  it("should normalize daily shortcut", () => {
    expect(normalizeSchedule("daily at 9am")).toBe('{"days":[0,1,2,3,4,5,6],"time":"09:00"}');
  });

  it("should normalize daily without time", () => {
    expect(normalizeSchedule("daily")).toBe('{"days":[0,1,2,3,4,5,6],"time":"00:00"}');
  });

  it("should normalize weekly shortcut", () => {
    expect(normalizeSchedule("weekly on monday at 9am")).toBe('{"days":[1],"time":"09:00"}');
  });

  it("should normalize cron interval", () => {
    expect(normalizeSchedule("*/5 * * * *")).toBe('{"every":5}');
  });

  it("should normalize cron hourly interval", () => {
    expect(normalizeSchedule("0 */2 * * *")).toBe('{"every":120}');
  });

  it("should normalize cron weekday schedule", () => {
    expect(normalizeSchedule("0 9 * * 1-5")).toBe('{"days":[1,2,3,4,5],"time":"09:00"}');
  });

  it("should normalize cron all-days schedule", () => {
    expect(normalizeSchedule("30 14 * * *")).toBe('{"days":[0,1,2,3,4,5,6],"time":"14:30"}');
  });

  it("should return null for garbage", () => {
    expect(normalizeSchedule("not a schedule")).toBeNull();
  });

  it("should be idempotent", () => {
    const first = normalizeSchedule("every 5 minutes");
    expect(normalizeSchedule(first!)).toBe(first);
  });
});

// ===========================================================================
// Schedule Next Run Time (JSON only)
// ===========================================================================

describe("Schedule Next Run Time", () => {
  it("should compute next time for interval", () => {
    const next = getNextRunTime('{"every":5}');
    expect(next).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    expect(next!).toBeLessThanOrEqual(now + 300);
  });

  it("should compute next time for weekly", () => {
    const next = getNextRunTime('{"days":[1,2,3,4,5],"time":"09:00"}');
    expect(next).not.toBeNull();
    const d = new Date(next! * 1000);
    expect(d.getHours()).toBe(9);
    expect([1, 2, 3, 4, 5]).toContain(d.getDay());
  });

  it("should return null for non-JSON input", () => {
    expect(getNextRunTime("every 5 minutes")).toBeNull();
    expect(getNextRunTime("*/5 * * * *")).toBeNull();
  });

  it("should return null for garbage", () => {
    expect(getNextRunTime("not a schedule")).toBeNull();
  });
});

// ===========================================================================
// /next Payload Integration
// ===========================================================================

describe("/next Payload", () => {
  it("should include docs and data in the run payload", () => {
    const agentId = seedAgent().id;
    const job = createJob(agentId, {
      name: "Full Job",
      instructions: "Do everything",
      schedule: '{"every":1}',
    });
    // Force next_run_at to the past so it fires
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    // Link a doc
    const doc = createDoc("Brand Guide", "Be consistent", "user", "u1");
    linkDocToJob(job!.id, doc!.id);

    // Link a database with data
    const db = createDatabase("history", [{ name: "entry", type: "TEXT" }]);
    linkDatabaseToJob(job!.id, db.id);
    insertRows(db.id, [{ entry: "past event" }]);

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.job.name).toBe("Full Job");
    expect(payload!.job.instructions).toBe("Do everything");
    expect(payload!.docs).toHaveLength(1);
    expect((payload!.docs[0] as any).title).toBe("Brand Guide");
    expect(payload!.data.history).toHaveLength(1);
  });

  it("should expose agent.eager=false on the payload by default", () => {
    const agentId = seedAgent().id;
    const job = createJob(agentId, { name: "J1", schedule: '{"every":1}' });
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect((payload as any).agent).toBeDefined();
    expect((payload as any).agent.eager).toBe(false);
  });

  it("should expose agent.eager=true on the payload when set", () => {
    const { id: agentId } = createAgent("eager-bot", undefined, { type: "harbour", cli: "claude-code", eager: true });
    const job = createJob(agentId, { name: "J1", schedule: '{"every":1}' });
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect((payload as any).agent.eager).toBe(true);
  });

  it("should reflect live eager toggle changes (no payload caching)", () => {
    const { id: agentId } = createAgent("toggle-bot", undefined, { type: "harbour", cli: "claude-code" });
    const job1 = createJob(agentId, { name: "J1", schedule: '{"every":1}' });
    updateJob(job1!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    let payload = getAgentNextRun(agentId);
    expect((payload as any).agent.eager).toBe(false);

    // Mark the run as done so the next poll picks up another job
    updateRunStatus(payload!.run.id, "done");

    // Toggle eager + queue another job
    updateAgent(agentId, { eager: true });
    const job2 = createJob(agentId, { name: "J2", schedule: '{"every":1}' });
    updateJob(job2!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    payload = getAgentNextRun(agentId);
    expect((payload as any).agent.eager).toBe(true);
  });
});

// ===========================================================================
// Trigger Job Run
// ===========================================================================

describe("Trigger Job Run", () => {
  let agentId: string;
  let jobId: string;

  beforeEach(() => {
    agentId = seedAgent().id;
    jobId = seedJob(agentId)!.id;
  });

  it("should create a scheduled run", () => {
    const result = triggerJobRun(jobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe(jobId);
    expect(result!.runId).toBeDefined();

    const run = getRunById(result!.runId);
    expect(run!.status).toBe("scheduled");
  });

  it("should create a run without extra instructions", () => {
    const result = triggerJobRun(jobId);
    const run = getRunById(result!.runId);
    expect(run!.extra_instructions).toBeNull();
  });

  it("should store extra instructions on the run", () => {
    const result = triggerJobRun(jobId, "Focus on error handling");
    const run = getRunById(result!.runId);
    expect(run!.extra_instructions).toBe("Focus on error handling");
  });

  it("should return null for non-existent job", () => {
    expect(triggerJobRun("non-existent")).toBeNull();
  });

  it("should include extra instructions in /next payload", () => {
    const job = createJob(agentId, {
      name: "Triggered Job",
      instructions: "Base instructions",
      schedule: '{"every":60}',
    });

    triggerJobRun(job!.id, "Extra context for this run");

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.job.instructions).toContain("Base instructions");
    expect(payload!.job.instructions).toContain("Extra context for this run");
    expect(payload!.job.instructions).toContain("Additional instructions for this run:");
  });

  it("should use only extra instructions when job has no instructions", () => {
    const job = createJob(agentId, {
      name: "No Instructions Job",
      schedule: '{"every":60}',
    });

    triggerJobRun(job!.id, "Only these instructions");

    const payload = getAgentNextRun(agentId);
    expect(payload).not.toBeNull();
    expect(payload!.job.instructions).toBe("Only these instructions");
  });
});

// ===========================================================================
// Run List Queries (job_active field)
// ===========================================================================

describe("Run List Queries", () => {
  let agentId: string;

  beforeEach(() => {
    agentId = seedAgent().id;
  });

  it("should include job_active in scheduled runs", () => {
    const job = seedJob(agentId);
    triggerJobRun(job!.id);

    const scheduled = listScheduledRuns();
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0] as any).job_active).toBe(1);
  });

  it("should reflect paused job in run listing", () => {
    const job = seedJob(agentId);
    updateJob(job!.id, { active: false });
    triggerJobRun(job!.id);

    const scheduled = listScheduledRuns();
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0] as any).job_active).toBe(0);
  });

  it("should include job_active in running runs", () => {
    const job = seedJob(agentId);
    createRun(job!.id, agentId);

    const running = listRunningRuns();
    expect(running).toHaveLength(1);
    expect((running[0] as any).job_active).toBe(1);
  });

  it("should include job_active in waiting runs", () => {
    const job = seedJob(agentId);
    const run = createRun(job!.id, agentId);
    updateRunStatus(run!.id, "waiting");

    const waiting = listWaitingRuns();
    expect(waiting).toHaveLength(1);
    expect((waiting[0] as any).job_active).toBe(1);
  });

  it("should include job_active in recent runs", () => {
    const job = seedJob(agentId);
    const run = createRun(job!.id, agentId);
    updateRunStatus(run!.id, "done");

    const recent = listRecentRuns();
    expect(recent).toHaveLength(1);
    expect((recent[0] as any).job_active).toBe(1);
  });
});
