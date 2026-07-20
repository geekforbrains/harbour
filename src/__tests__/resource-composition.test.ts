import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createDoc,
  createEnvVar,
  createJob,
  createProject,
  createRun,
  createTable,
  getJobById,
  insertRows,
  linkDocToJob,
  linkEnvVarToJob,
  linkTableToJob,
  toggleDocPinned,
  toggleEnvVarPinned,
  toggleTablePinned,
  updateJob,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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

const SCHEDULE = '{"every":60}';

function fixture() {
  const project = createProject("Website")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "Build", schedule: SCHEDULE })!;
  return { project, agent, job };
}

// ---------------------------------------------------------------------------
// Run-bundle composition: pinned resources of the job's OWN project inject
// automatically, then resources explicitly linked via job_docs / job_env_vars /
// job_tables (any project) in link-table rowid order — on a name collision the
// later assignment wins. Tables are read references: name + id only, no rows
// or columns.
// ---------------------------------------------------------------------------

describe("run payload resource injection", () => {
  it("injects pinned own-project resources plus linked ones; everything else is excluded", () => {
    const { project, agent, job } = fixture();

    // Env vars: one pinned, one linked, one plain — only the first two inject.
    const pinnedVar = createEnvVar(project.id, "PINNED_VAR", "pinned-val")!;
    toggleEnvVarPinned(pinnedVar.id);
    const linkedVar = createEnvVar(project.id, "LINKED_VAR", "linked-val")!;
    linkEnvVarToJob(job.id, linkedVar.id);
    createEnvVar(project.id, "PLAIN_VAR", "plain-val");

    // Docs: same trio.
    const pinnedDoc = createDoc(project.id, "Pinned Doc", "pinned body")!;
    toggleDocPinned(pinnedDoc.id);
    const linkedDoc = createDoc(project.id, "Linked Doc", "linked body")!;
    linkDocToJob(job.id, linkedDoc.id);
    createDoc(project.id, "Plain Doc", "plain body");

    // Tables: same trio. Rows exist but must NOT be injected.
    const pinnedTable = createTable(project.id, "pinned_table", [{ name: "v", type: "TEXT" }]);
    toggleTablePinned(pinnedTable.id);
    const linkedTable = createTable(project.id, "linked_table", [{ name: "v", type: "TEXT" }]);
    insertRows(linkedTable.id, [{ v: "linked-row" }]);
    linkTableToJob(job.id, linkedTable.id);
    createTable(project.id, "plain_table", [{ name: "v", type: "TEXT" }]);

    const run = createRun(job.id, agent.id)!;
    const payload = buildRunPayload(run.id)!;

    expect(payload.env).toEqual({ PINNED_VAR: "pinned-val", LINKED_VAR: "linked-val" });

    expect(payload.docs.map((d) => d.id).sort()).toEqual([pinnedDoc.id, linkedDoc.id].sort());
    expect(payload.docs.find((d) => d.id === linkedDoc.id)?.content).toBe("linked body");

    // Tables: exposed as name → { id } — no columns, no rows.
    expect(payload.tables).toEqual({
      pinned_table: { id: pinnedTable.id },
      linked_table: { id: linkedTable.id },
    });
  });

  it("pinned resources of ANOTHER project never inject — pinning is project-local", () => {
    const { agent, job } = fixture();
    const other = createProject("Other")!;

    const foreignPinnedDoc = createDoc(other.id, "Foreign Pinned", "f")!;
    toggleDocPinned(foreignPinnedDoc.id);
    const foreignPinnedVar = createEnvVar(other.id, "FOREIGN_VAR", "f")!;
    toggleEnvVarPinned(foreignPinnedVar.id);
    const foreignPinnedTable = createTable(other.id, "foreign_table", [
      { name: "v", type: "TEXT" },
    ]);
    toggleTablePinned(foreignPinnedTable.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.env).toEqual({});
    expect(payload.docs).toEqual([]);
    expect(payload.tables).toEqual({});
  });

  it("cross-project links are legal and inject like any other link", () => {
    const { agent, job } = fixture();
    const other = createProject("Other")!;

    const foreignDoc = createDoc(other.id, "Foreign Doc", "foreign body")!;
    const foreignVar = createEnvVar(other.id, "FOREIGN_VAR", "foreign-val")!;
    const foreignTable = createTable(other.id, "foreign_table", [{ name: "v", type: "TEXT" }]);
    linkDocToJob(job.id, foreignDoc.id);
    linkEnvVarToJob(job.id, foreignVar.id);
    linkTableToJob(job.id, foreignTable.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.docs.map((d) => d.id)).toEqual([foreignDoc.id]);
    expect(payload.env.FOREIGN_VAR).toBe("foreign-val");
    expect(payload.tables.foreign_table).toEqual({ id: foreignTable.id });
  });

  it("a doc that is both pinned and linked appears once", () => {
    const { project, agent, job } = fixture();
    const doc = createDoc(project.id, "Both", "body")!;
    toggleDocPinned(doc.id);
    linkDocToJob(job.id, doc.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.docs.map((d) => d.id)).toEqual([doc.id]);
  });

  it("unlinking a resource stops it being injected", () => {
    const { project, agent, job } = fixture();
    const doc = createDoc(project.id, "Doc", "body")!;
    linkDocToJob(job.id, doc.id);
    expect(buildRunPayload(createRun(job.id, agent.id)!.id)!.docs.map((d) => d.id)).toEqual([
      doc.id,
    ]);

    updateJob(job.id, { docIds: [] });
    expect(buildRunPayload(createRun(job.id, agent.id)!.id)!.docs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Name-collision precedence: composition assigns pinned first, then linked in
// link order — the later assignment wins.
// ---------------------------------------------------------------------------

describe("name-collision precedence", () => {
  it("a linked env var overrides a pinned same-name var from the job's project", () => {
    const { project, agent, job } = fixture();
    const other = createProject("Other")!;

    const pinned = createEnvVar(project.id, "API_BASE", "https://own.example")!;
    toggleEnvVarPinned(pinned.id);
    const linked = createEnvVar(other.id, "API_BASE", "https://linked.example")!;
    linkEnvVarToJob(job.id, linked.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.env.API_BASE).toBe("https://linked.example");
  });

  it("between two linked tables of one logical name, the later link wins", () => {
    const { project, agent } = fixture();
    const other = createProject("Other")!;
    // Both projects own a table with the logical name "shared"; the physical
    // table_name is globally unique via the id suffix, so both can exist.
    const tableA = createTable(project.id, "shared", [{ name: "v", type: "TEXT" }]);
    const tableB = createTable(other.id, "shared", [{ name: "v", type: "TEXT" }]);

    const jobAB = createJob(project.id, agent.id, { name: "AB", schedule: SCHEDULE })!;
    linkTableToJob(jobAB.id, tableA.id);
    linkTableToJob(jobAB.id, tableB.id);
    expect(buildRunPayload(createRun(jobAB.id, agent.id)!.id)!.tables.shared).toEqual({
      id: tableB.id,
    });

    // Reverse link order on a sibling job — the other table wins there.
    const jobBA = createJob(project.id, agent.id, { name: "BA", schedule: SCHEDULE })!;
    linkTableToJob(jobBA.id, tableB.id);
    linkTableToJob(jobBA.id, tableA.id);
    expect(buildRunPayload(createRun(jobBA.id, agent.id)!.id)!.tables.shared).toEqual({
      id: tableA.id,
    });
  });

  it("between two linked env vars of one name, link order decides — not creation order", () => {
    const { agent, job } = fixture();
    const otherA = createProject("Other A")!;
    const otherB = createProject("Other B")!;
    const older = createEnvVar(otherA.id, "TOKEN", "older")!;
    const newer = createEnvVar(otherB.id, "TOKEN", "newer")!;

    // Link the newer var first, the older second: the older (later link) wins.
    linkEnvVarToJob(job.id, newer.id);
    linkEnvVarToJob(job.id, older.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.env.TOKEN).toBe("older");
  });
});

// ---------------------------------------------------------------------------
// Link atomicity — createJob/updateJob link resources inside one transaction;
// a bad resource id (FK violation) rolls the whole write back.
// ---------------------------------------------------------------------------

describe("link atomicity", () => {
  it("a createJob with an unknown doc id rolls back — no job row left behind", () => {
    const { project, agent } = fixture();
    expect(() =>
      createJob(project.id, agent.id, { name: "Bad", schedule: SCHEDULE, docIds: ["nope"] }),
    ).toThrow(/FOREIGN KEY/);
    const count = getDb().prepare(`SELECT COUNT(*) as n FROM jobs`).get() as { n: number };
    expect(count.n).toBe(1); // only the fixture's job remains
  });

  it("an updateJob with an unknown doc id rolls back — name and existing links survive", () => {
    const { project, job } = fixture();
    const doc = createDoc(project.id, "Doc", "body")!;
    linkDocToJob(job.id, doc.id);

    expect(() => updateJob(job.id, { name: "renamed", docIds: ["nope"] })).toThrow(/FOREIGN KEY/);

    const after = getJobById(job.id)!;
    expect(after.name).toBe("Build"); // the whole update rolled back, not just the links
    expect(after.docs.map((d: { id: string }) => d.id)).toEqual([doc.id]);
  });
});
