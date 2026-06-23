import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  getDecryptedEnvVarsForJob,
  linkEnvVarToJob,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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

const SCHEDULE = '{"every":60}';

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "J", schedule: SCHEDULE })!;
  return { org, project, agent, job };
}

// ---------------------------------------------------------------------------
// Same-tier name uniqueness (the baseline the override relies on): an org-level
// name and a project-level name may coincide, but within a single tier a name
// is unique. Two projects may independently use the same name.
// ---------------------------------------------------------------------------

describe("env-var same-tier name uniqueness", () => {
  it("rejects a duplicate org-level name", () => {
    const { org } = fixture();
    createEnvVar(org.id, null, "DUP", "a");
    expect(() => createEnvVar(org.id, null, "DUP", "b")).toThrow(/already exists at the org level/);
  });

  it("rejects a duplicate project-level name", () => {
    const { org, project } = fixture();
    createEnvVar(org.id, project.id, "DUP", "a");
    expect(() => createEnvVar(org.id, project.id, "DUP", "b")).toThrow(
      /already exists at the project level/,
    );
  });

  it("allows the same name across tiers (org + project)", () => {
    const { org, project } = fixture();
    createEnvVar(org.id, null, "SHARED", "org");
    expect(() => createEnvVar(org.id, project.id, "SHARED", "proj")).not.toThrow();
  });

  it("allows the same name in two different projects of one org", () => {
    const { org, project } = fixture();
    const project2 = createProject(org.id, "Site2")!;
    createEnvVar(org.id, project.id, "X", "a");
    expect(() => createEnvVar(org.id, project2.id, "X", "b")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Project-over-org override at injection: when a project-level and an org-level
// var with the same name are both linked to one job, the project value wins —
// deterministically, regardless of the order they were linked.
// ---------------------------------------------------------------------------

describe("env-var project-over-org override", () => {
  it("project value wins when org + project vars of the same name are linked", () => {
    const { org, project, job } = fixture();
    const orgVar = createEnvVar(org.id, null, "API_BASE", "https://org.example")!;
    const projVar = createEnvVar(org.id, project.id, "API_BASE", "https://proj.example")!;
    linkEnvVarToJob(job.id, orgVar.id);
    linkEnvVarToJob(job.id, projVar.id);

    const env = getDecryptedEnvVarsForJob(job.id);
    expect(env.API_BASE).toBe("https://proj.example");
  });

  it("is deterministic regardless of link order (project linked first)", () => {
    const { org, project, job } = fixture();
    const orgVar = createEnvVar(org.id, null, "API_BASE", "https://org.example")!;
    const projVar = createEnvVar(org.id, project.id, "API_BASE", "https://proj.example")!;
    // Link project first, then org — project must still win.
    linkEnvVarToJob(job.id, projVar.id);
    linkEnvVarToJob(job.id, orgVar.id);

    const env = getDecryptedEnvVarsForJob(job.id);
    expect(env.API_BASE).toBe("https://proj.example");
  });

  it("keeps distinct names from both tiers", () => {
    const { org, project, job } = fixture();
    const orgVar = createEnvVar(org.id, null, "ORG_ONLY", "o")!;
    const projVar = createEnvVar(org.id, project.id, "PROJ_ONLY", "p")!;
    linkEnvVarToJob(job.id, orgVar.id);
    linkEnvVarToJob(job.id, projVar.id);

    const env = getDecryptedEnvVarsForJob(job.id);
    expect(env).toEqual({ ORG_ONLY: "o", PROJ_ONLY: "p" });
  });
});
