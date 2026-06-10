import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createDatabase,
  createDoc,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  createRun,
  insertRows,
  linkDatabaseToJob,
  linkDocToJob,
  linkEnvVarToJob,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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
// Resource model injection — composition of org + project + job-linked tiers
// ---------------------------------------------------------------------------

describe("run payload resource composition", () => {
  it("composes all three tiers with project-over-org and job-over-all precedence", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    // --- Env vars across all three tiers, with deliberate name collisions ---
    // SHARED_KEY exists at all three tiers; SCOPE proves which tier won.
    createEnvVar(org.id, null, "ORG_ONLY", "org-only-val");
    createEnvVar(org.id, null, "SHARED_KEY", "from-org");
    createEnvVar(org.id, null, "OVERRIDE_ME", "org-loses");

    createEnvVar(org.id, project.id, "PROJECT_ONLY", "project-only-val");
    createEnvVar(org.id, project.id, "SHARED_KEY", "from-project"); // beats org
    createEnvVar(org.id, project.id, "OVERRIDE_ME", "project-loses-to-job");

    const jobVar = createEnvVar(org.id, project.id, "JOB_ONLY", "job-only-val")!;
    linkEnvVarToJob(job.id, jobVar.id);
    // A job-linked var (its own name) demonstrates the linked tier is layered
    // last; the dedicated same-name override case is covered by the next test.
    const jobOverride = createEnvVar(org.id, null, "JOB_OVERRIDE_HOLDER", "job-wins")!;
    linkEnvVarToJob(job.id, jobOverride.id);

    // --- Docs: org pinned, project, and one doc both pinned-at-org AND linked
    const orgDoc = createDoc(org.id, null, "Org Doc", "org doc body")!;
    const projDoc = createDoc(org.id, project.id, "Project Doc", "project doc body")!;
    const dupDoc = createDoc(org.id, project.id, "Dup Doc", "dup body")!;
    linkDocToJob(job.id, dupDoc.id); // also a project-tier doc → must appear once

    // --- Databases across tiers ---
    const orgDb = createDatabase(org.id, null, "org_table", [{ name: "v", type: "TEXT" }]);
    insertRows(orgDb.id, [{ v: "org-row" }]);
    const projDb = createDatabase(org.id, project.id, "project_table", [
      { name: "v", type: "TEXT" },
    ]);
    insertRows(projDb.id, [{ v: "project-row" }]);
    const linkedDb = createDatabase(org.id, project.id, "linked_table", [
      { name: "v", type: "TEXT" },
    ]);
    insertRows(linkedDb.id, [{ v: "linked-row" }]);
    linkDatabaseToJob(job.id, linkedDb.id);

    const run = createRun(job.id, agent.id)!;
    const payload = buildRunPayload(run.id)!;
    expect(payload).toBeTruthy();

    // (a) all three env tiers present
    expect(payload.env.ORG_ONLY).toBe("org-only-val");
    expect(payload.env.PROJECT_ONLY).toBe("project-only-val");
    expect(payload.env.JOB_ONLY).toBe("job-only-val");

    // (b) project-over-org override wins on name collision
    expect(payload.env.SHARED_KEY).toBe("from-project");

    // (c) job-linked wins over both. OVERRIDE_ME is org+project; the job-linked
    //     JOB_OVERRIDE_HOLDER proves the linked tier is layered last.
    expect(payload.env.OVERRIDE_ME).toBe("project-loses-to-job"); // project beats org
    expect(payload.env.JOB_OVERRIDE_HOLDER).toBe("job-wins");

    // (d) de-dup: a doc that is both project-tier and job-linked appears once
    const dupCount = payload.docs.filter((d) => d.id === dupDoc.id).length;
    expect(dupCount).toBe(1);
    const docIds = payload.docs.map((d) => d.id);
    expect(docIds).toContain(orgDoc.id);
    expect(docIds).toContain(projDoc.id);
    expect(docIds).toContain(dupDoc.id);
    // content carried through
    expect(payload.docs.find((d) => d.id === orgDoc.id)?.content).toBe("org doc body");

    // databases: all three tiers present, each carrying id + columns + rows so
    // an agent can actually write back (not just read injected rows).
    expect(payload.data.org_table.rows).toEqual([expect.objectContaining({ v: "org-row" })]);
    expect(payload.data.project_table.rows).toEqual([
      expect.objectContaining({ v: "project-row" }),
    ]);
    expect(payload.data.linked_table.rows).toEqual([expect.objectContaining({ v: "linked-row" })]);

    // each injected database exposes the id (to target insert_rows/read_rows)
    // and its column schema (so the agent knows valid column names).
    expect(payload.data.org_table.id).toBe(orgDb.id);
    expect(payload.data.org_table.columns).toEqual([
      expect.objectContaining({ name: "v", type: "TEXT" }),
    ]);
  });

  it("job-linked env var overrides project- and org-level on the same name", () => {
    // env var names are unique per tier, so to exercise a true name collision at
    // the JOB-LINKED tier we link an org-level var while a project-level var of
    // the same name also exists — the linked tier is applied last, so it wins.
    const org = createOrg("Acme")!;
    const projA = createProject(org.id, "A")!;
    const agent = createAgent(projA.id, "Dev");
    const job = createJob(projA.id, agent.id, { name: "J", schedule: '{"every":60}' })!;

    // Same NAME at org and project tiers.
    createEnvVar(org.id, null, "TOKEN", "org-token");
    createEnvVar(org.id, projA.id, "TOKEN", "project-token");
    // Without a link: project wins.
    const r1 = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(r1.env.TOKEN).toBe("project-token");

    // Now link the org-level TOKEN explicitly to the job. The job-linked tier is
    // applied last in the composition, so its value wins over the project tier.
    const orgToken = createEnvVar(org.id, null, "TOKEN2", "org-token2")!;
    linkEnvVarToJob(job.id, orgToken.id);
    const r2 = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(r2.env.TOKEN2).toBe("org-token2");
  });

  it("does not leak project B resources into a project A run; org resources reach all projects", () => {
    const org = createOrg("Acme")!;
    const projA = createProject(org.id, "A")!;
    const projB = createProject(org.id, "B")!;
    const agentA = createAgent(projA.id, "DevA");
    const agentB = createAgent(projB.id, "DevB");
    const jobA = createJob(projA.id, agentA.id, { name: "JA", schedule: '{"every":60}' })!;
    const jobB = createJob(projB.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;

    // Org-level resources (should reach BOTH projects)
    createEnvVar(org.id, null, "ORG_VAR", "org-val");
    createDoc(org.id, null, "Org Doc", "org body");
    const orgDb = createDatabase(org.id, null, "org_data", [{ name: "v", type: "TEXT" }]);
    insertRows(orgDb.id, [{ v: "x" }]);

    // Project-A-only resources
    createEnvVar(org.id, projA.id, "A_VAR", "a-val");
    createDoc(org.id, projA.id, "A Doc", "a body");
    const aDb = createDatabase(org.id, projA.id, "a_data", [{ name: "v", type: "TEXT" }]);
    insertRows(aDb.id, [{ v: "a" }]);

    // Project-B-only resources
    createEnvVar(org.id, projB.id, "B_VAR", "b-val");
    createDoc(org.id, projB.id, "B Doc", "b body");
    const bDb = createDatabase(org.id, projB.id, "b_data", [{ name: "v", type: "TEXT" }]);
    insertRows(bDb.id, [{ v: "b" }]);

    const payloadA = buildRunPayload(createRun(jobA.id, agentA.id)!.id)!;

    // (f) org-level reaches project A
    expect(payloadA.env.ORG_VAR).toBe("org-val");
    expect(payloadA.docs.map((d) => d.title)).toContain("Org Doc");
    expect(payloadA.data.org_data).toBeTruthy();

    // project A's own resources present
    expect(payloadA.env.A_VAR).toBe("a-val");

    // (e) project B's project-level resources DO NOT leak into A's run
    expect(payloadA.env.B_VAR).toBeUndefined();
    expect(payloadA.docs.map((d) => d.title)).not.toContain("B Doc");
    expect(payloadA.data.b_data).toBeUndefined();

    // org-level also reaches project B (symmetry)
    const payloadB = buildRunPayload(createRun(jobB.id, agentB.id)!.id)!;
    expect(payloadB.env.ORG_VAR).toBe("org-val");
    expect(payloadB.env.B_VAR).toBe("b-val");
    expect(payloadB.env.A_VAR).toBeUndefined();
    expect(payloadB.data.org_data).toBeTruthy();
    expect(payloadB.data.a_data).toBeUndefined();
  });
});
