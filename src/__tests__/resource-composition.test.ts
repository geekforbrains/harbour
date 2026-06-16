import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createDoc,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  createRun,
  createTable,
  insertRows,
  linkDocToJob,
  linkEnvVarToJob,
  linkTableToJob,
  toggleDocPinned,
  toggleEnvVarPinned,
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
// Resource injection — attachment-driven: a run carries only the resources
// linked to its job (job_docs / job_env_vars / job_tables), never the
// org/project tiers at large. Pinned docs/vars/tables reach a job by auto-attaching at
// job create. Tables are read references: name + id only, no rows/columns.
// ---------------------------------------------------------------------------

describe("run payload resource injection", () => {
  it("injects only job-linked resources; unlinked org/project resources are excluded", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    // Env vars: one org-level + one project-level linked, the rest unlinked.
    createEnvVar(org.id, null, "ORG_UNLINKED", "org-unlinked-val");
    createEnvVar(org.id, project.id, "PROJ_UNLINKED", "proj-unlinked-val");
    const linkedOrgVar = createEnvVar(org.id, null, "ORG_LINKED", "org-linked-val")!;
    const linkedProjVar = createEnvVar(org.id, project.id, "PROJ_LINKED", "proj-linked-val")!;
    linkEnvVarToJob(job.id, linkedOrgVar.id);
    linkEnvVarToJob(job.id, linkedProjVar.id);

    // Docs: one linked, one unlinked.
    const linkedDoc = createDoc(org.id, project.id, "Linked Doc", "linked doc body")!;
    createDoc(org.id, null, "Unlinked Doc", "unlinked doc body");
    linkDocToJob(job.id, linkedDoc.id);

    // Tables: one linked, one unlinked. Rows exist but must NOT be injected.
    const linkedDb = createTable(org.id, project.id, "linked_table", [{ name: "v", type: "TEXT" }]);
    insertRows(linkedDb.id, [{ v: "linked-row" }]);
    const unlinkedDb = createTable(org.id, null, "unlinked_table", [{ name: "v", type: "TEXT" }]);
    insertRows(unlinkedDb.id, [{ v: "unlinked-row" }]);
    linkTableToJob(job.id, linkedDb.id);

    const run = createRun(job.id, agent.id)!;
    const payload = buildRunPayload(run.id)!;
    expect(payload).toBeTruthy();

    // Env: only linked vars (either tier) appear; unlinked never do.
    expect(payload.env.ORG_LINKED).toBe("org-linked-val");
    expect(payload.env.PROJ_LINKED).toBe("proj-linked-val");
    expect(payload.env.ORG_UNLINKED).toBeUndefined();
    expect(payload.env.PROJ_UNLINKED).toBeUndefined();

    // Docs: only the linked one, with content carried through.
    expect(payload.docs.map((d) => d.id)).toEqual([linkedDoc.id]);
    expect(payload.docs[0].content).toBe("linked doc body");

    // Tables: linked one only, exposed as name + id — no columns, no rows.
    expect(payload.tables.linked_table).toEqual({ id: linkedDb.id });
    expect(payload.tables.unlinked_table).toBeUndefined();
  });

  it("auto-attaches pinned docs/vars to a new job and injects them; unpinned are excluded", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev");

    // Pinned resources become creation-time defaults; unpinned ones don't.
    const pinnedDoc = createDoc(org.id, null, "Pinned Doc", "pinned body")!;
    toggleDocPinned(pinnedDoc.id);
    createDoc(org.id, project.id, "Unpinned Doc", "unpinned body");

    const pinnedVar = createEnvVar(org.id, project.id, "PINNED_VAR", "pinned-val")!;
    toggleEnvVarPinned(pinnedVar.id);
    createEnvVar(org.id, null, "UNPINNED_VAR", "unpinned-val");

    // Job created AFTER pinning → pinned resources auto-attach as removable links.
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.docs.map((d) => d.id)).toEqual([pinnedDoc.id]);
    expect(payload.env.PINNED_VAR).toBe("pinned-val");
    expect(payload.env.UNPINNED_VAR).toBeUndefined();
  });

  it("does not inject resources from another project or any unlinked resource", () => {
    const org = createOrg("Acme")!;
    const projA = createProject(org.id, "A")!;
    const projB = createProject(org.id, "B")!;
    const agentA = createAgent(projA.id, "DevA");
    const jobA = createJob(projA.id, agentA.id, { name: "JA", schedule: '{"every":60}' })!;

    // Org- and project-level resources of every kind, none linked to jobA.
    createEnvVar(org.id, null, "ORG_VAR", "org-val");
    createDoc(org.id, null, "Org Doc", "org body");
    const orgDb = createTable(org.id, null, "org_data", [{ name: "v", type: "TEXT" }]);
    insertRows(orgDb.id, [{ v: "x" }]);

    createEnvVar(org.id, projA.id, "A_VAR", "a-val");
    createDoc(org.id, projA.id, "A Doc", "a body");
    createEnvVar(org.id, projB.id, "B_VAR", "b-val");
    createDoc(org.id, projB.id, "B Doc", "b body");

    const payloadA = buildRunPayload(createRun(jobA.id, agentA.id)!.id)!;

    // Nothing is auto-injected — not org-level, not own-project, not project B.
    expect(payloadA.env).toEqual({});
    expect(payloadA.docs).toEqual([]);
    expect(payloadA.tables).toEqual({});
  });
});
