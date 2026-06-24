import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOrg,
  createProject,
  createRun,
  createWorkflow,
  listRecentRuns,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Setup / Teardown — fresh in-memory v2 DB per test (mirrors the other suites)
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

type RecentRow = {
  id: string;
  job_id: string;
  status: string;
  completed_at: number | null;
  collapsed_count?: number | null;
};

// A strictly increasing clock so each run gets a distinct, ordered completed_at
// (later calls are newer). Started in the past to stay below unixepoch().
let clock = Math.floor(Date.now() / 1000) - 100000;

function makeWorkflow(orgId: string, projectId: string, name: string) {
  return createWorkflow(orgId, projectId, {
    name,
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo hi" },
  })!;
}

/** Create a completed run for a job with a given status and a fresh timestamp. */
function addRun(jobId: string, status: string): string {
  clock += 1;
  const run = createRun(jobId, null)!;
  getDb()
    .prepare(`UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`)
    .run(status, clock, run.id);
  return run.id;
}

function rowsFor(rows: RecentRow[], jobId: string, status: string) {
  return rows.filter((r) => r.job_id === jobId && r.status === status);
}

describe("listRecentRuns: collapsing", () => {
  it("collapses done + skipped per job, keeps failures individual (collapse on)", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const sync = makeWorkflow(org.id, project.id, "Sync");
    const build = makeWorkflow(org.id, project.id, "Build");

    for (let i = 0; i < 5; i++) addRun(sync.id, "done");
    for (let i = 0; i < 3; i++) addRun(sync.id, "skipped");
    addRun(sync.id, "failed");
    for (let i = 0; i < 2; i++) addRun(build.id, "done");

    const rows = listRecentRuns(org.id, 50, project.id, { collapseDone: true }) as RecentRow[];

    // Sync: one done summary (5), one skipped summary (3), one individual failure.
    const syncDone = rowsFor(rows, sync.id, "done");
    expect(syncDone).toHaveLength(1);
    expect(syncDone[0].collapsed_count).toBe(5);

    const syncSkipped = rowsFor(rows, sync.id, "skipped");
    expect(syncSkipped).toHaveLength(1);
    expect(syncSkipped[0].collapsed_count).toBe(3);

    const syncFailed = rowsFor(rows, sync.id, "failed");
    expect(syncFailed).toHaveLength(1);
    expect(syncFailed[0].collapsed_count ?? null).toBeNull();

    // Build's successes collapse independently of Sync's.
    const buildDone = rowsFor(rows, build.id, "done");
    expect(buildDone).toHaveLength(1);
    expect(buildDone[0].collapsed_count).toBe(2);

    expect(rows).toHaveLength(4);
  });

  it("leaves successes individual but still collapses skipped (collapse off)", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const sync = makeWorkflow(org.id, project.id, "Sync");

    for (let i = 0; i < 5; i++) addRun(sync.id, "done");
    for (let i = 0; i < 3; i++) addRun(sync.id, "skipped");
    addRun(sync.id, "failed");

    const rows = listRecentRuns(org.id, 50, project.id, { collapseDone: false }) as RecentRow[];

    // Successes are no longer folded.
    const done = rowsFor(rows, sync.id, "done");
    expect(done).toHaveLength(5);
    expect(done.every((r) => (r.collapsed_count ?? null) === null)).toBe(true);

    // Skipped is collapsed regardless of the toggle.
    const skipped = rowsFor(rows, sync.id, "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].collapsed_count).toBe(3);

    // 5 done + 1 skipped summary + 1 failed.
    expect(rows).toHaveLength(7);
  });

  it("never collapses failures, even many of the same job", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const sync = makeWorkflow(org.id, project.id, "Sync");

    for (let i = 0; i < 4; i++) addRun(sync.id, "failed");

    const rows = listRecentRuns(org.id, 50, project.id) as RecentRow[];
    expect(rowsFor(rows, sync.id, "failed")).toHaveLength(4);
  });

  it("a collapsed row carries the newest run of its group and sorts newest-first", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const sync = makeWorkflow(org.id, project.id, "Sync");

    addRun(sync.id, "done");
    const newestDone = addRun(sync.id, "done"); // most recent of the done group
    const failure = addRun(sync.id, "failed"); // newest run overall

    const rows = listRecentRuns(org.id, 50, project.id, { collapseDone: true }) as RecentRow[];

    // Failure is newest → first row. Done summary points at its newest member.
    expect(rows[0].id).toBe(failure);
    const doneRow = rowsFor(rows, sync.id, "done")[0];
    expect(doneRow.id).toBe(newestDone);
    expect(doneRow.collapsed_count).toBe(2);
  });

  it("caps the returned rows at the limit, newest first", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    // Distinct jobs so nothing collapses — three rows compete for two slots.
    const a = makeWorkflow(org.id, project.id, "A");
    const b = makeWorkflow(org.id, project.id, "B");
    const c = makeWorkflow(org.id, project.id, "C");

    addRun(a.id, "failed");
    const second = addRun(b.id, "failed");
    const newest = addRun(c.id, "failed");

    const rows = listRecentRuns(org.id, 2, project.id) as RecentRow[];
    expect(rows.map((r) => r.id)).toEqual([newest, second]);
  });
});
