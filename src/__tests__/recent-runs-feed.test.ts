import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, createRun, createWorkflow, listRecentRuns } from "@/lib/db/queries";
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
};

// A strictly increasing clock so each run gets a distinct, ordered completed_at
// (later calls are newer). Started in the past to stay below unixepoch().
let clock = Math.floor(Date.now() / 1000) - 100000;

function makeWorkflow(projectId: string, name: string) {
  return createWorkflow(projectId, {
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

describe("listRecentRuns: the Recent feed", () => {
  it("excludes skipped runs entirely", () => {
    const project = createProject("Site")!;
    const sync = makeWorkflow(project.id, "Sync");

    addRun(sync.id, "done");
    for (let i = 0; i < 5; i++) addRun(sync.id, "skipped");
    addRun(sync.id, "failed");

    const rows = listRecentRuns(project.id, 50) as RecentRow[];

    expect(rows.some((r) => r.status === "skipped")).toBe(false);
    expect(rows).toHaveLength(2); // the done + the failed
  });

  it("caps a job's successes at perJobLimit, keeping the newest", () => {
    const project = createProject("Site")!;
    const sync = makeWorkflow(project.id, "Sync");

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(addRun(sync.id, "done"));

    const rows = listRecentRuns(project.id, 50, { perJobLimit: 2 }) as RecentRow[];

    const done = rowsFor(rows, sync.id, "done");
    expect(done).toHaveLength(2);
    // The two newest of the five, newest first.
    expect(done.map((r) => r.id)).toEqual([ids[4], ids[3]]);
  });

  it("defaults the per-job cap to 3", () => {
    const project = createProject("Site")!;
    const sync = makeWorkflow(project.id, "Sync");

    for (let i = 0; i < 6; i++) addRun(sync.id, "done");

    const rows = listRecentRuns(project.id, 50) as RecentRow[];
    expect(rowsFor(rows, sync.id, "done")).toHaveLength(3);
  });

  it("never caps failures or killed runs", () => {
    const project = createProject("Site")!;
    const sync = makeWorkflow(project.id, "Sync");

    for (let i = 0; i < 5; i++) addRun(sync.id, "failed");
    for (let i = 0; i < 4; i++) addRun(sync.id, "killed");

    const rows = listRecentRuns(project.id, 50, { perJobLimit: 1 }) as RecentRow[];
    expect(rowsFor(rows, sync.id, "failed")).toHaveLength(5);
    expect(rowsFor(rows, sync.id, "killed")).toHaveLength(4);
  });

  it("a chatty job's older successes free slots for other jobs' runs", () => {
    const project = createProject("Site")!;
    const quiet = makeWorkflow(project.id, "Quiet");
    const chatty = makeWorkflow(project.id, "Chatty");

    const quietRun = addRun(quiet.id, "done"); // oldest run overall
    for (let i = 0; i < 10; i++) addRun(chatty.id, "done");

    // Uncapped, chatty's 10 newer successes would fill the whole feed of 5.
    const rows = listRecentRuns(project.id, 5, { perJobLimit: 3 }) as RecentRow[];

    expect(rowsFor(rows, chatty.id, "done")).toHaveLength(3);
    expect(rows.some((r) => r.id === quietRun)).toBe(true);
  });

  it("caps the returned rows at the limit, newest first", () => {
    const project = createProject("Site")!;
    const a = makeWorkflow(project.id, "A");
    const b = makeWorkflow(project.id, "B");
    const c = makeWorkflow(project.id, "C");

    addRun(a.id, "failed");
    const second = addRun(b.id, "failed");
    const newest = addRun(c.id, "failed");

    const rows = listRecentRuns(project.id, 2) as RecentRow[];
    expect(rows.map((r) => r.id)).toEqual([newest, second]);
  });

  it("unions across all projects when projectId is omitted", () => {
    const a = makeWorkflow(createProject("Site A")!.id, "A");
    const b = makeWorkflow(createProject("Site B")!.id, "B");

    addRun(a.id, "done");
    addRun(b.id, "failed");

    const rows = listRecentRuns(undefined, 50) as RecentRow[];
    expect(rows.map((r) => r.job_id).sort()).toEqual([a.id, b.id].sort());
  });
});
