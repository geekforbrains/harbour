import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import {
  createOrg,
  createProject,
  createAgent,
  createJob,
  createRun,
  getRunById,
  updateRunStatus,
  IllegalRunStatusTransition,
} from "@/lib/db/queries";

// ---------------------------------------------------------------------------
// Setup — fresh in-memory v2 DB per test (mirrors schema.test.ts)
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

// A run is born 'running' (createRun INSERTs 'running'). To exercise edges out
// of an arbitrary status we seed the column directly, bypassing the guard the
// same way the test fixtures in workflow-runs.test.ts do.
function makeRun(status: string): string {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Website")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  getDb().prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, run.id);
  return run.id;
}

// ===========================================================================
// Legal edges — every documented transition must succeed
// ===========================================================================

const LEGAL_EDGES: [from: string, to: string][] = [
  ["scheduled", "running"],
  ["running", "waiting"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "skipped"],
  ["running", "killed"],
  ["waiting", "pending"],
  ["pending", "running"],
  // resume-from-terminal (retry route + activity-route human resume)
  ["failed", "pending"],
  ["skipped", "pending"],
  ["killed", "pending"],
  ["done", "pending"],
  // postrun override (#29): a 'done' run can be forced to 'failed'
  ["done", "failed"],
];

describe("run status transitions — legal edges", () => {
  for (const [from, to] of LEGAL_EDGES) {
    it(`allows ${from} -> ${to}`, () => {
      const id = makeRun(from);
      const updated = updateRunStatus(id, to);
      expect(updated!.status).toBe(to);
      expect(getRunById(id)!.status).toBe(to);
    });
  }
});

// ===========================================================================
// Illegal edges — representative jumps must throw IllegalRunStatusTransition
// ===========================================================================

const ILLEGAL_EDGES: [from: string, to: string][] = [
  ["scheduled", "done"],     // can't complete what never ran
  ["scheduled", "waiting"],
  ["done", "running"],       // terminal can't go back to running
  ["failed", "running"],     // resume goes via 'pending', not straight to running
  ["killed", "running"],
  ["done", "skipped"],       // only done -> pending | failed are legal out of done
  ["waiting", "running"],    // human-loop resume goes waiting -> pending -> running
  ["pending", "done"],
];

describe("run status transitions — illegal edges throw", () => {
  for (const [from, to] of ILLEGAL_EDGES) {
    it(`rejects ${from} -> ${to}`, () => {
      const id = makeRun(from);
      expect(() => updateRunStatus(id, to)).toThrow(IllegalRunStatusTransition);
      // The status column is unchanged after a rejected transition.
      expect(getRunById(id)!.status).toBe(from);
    });
  }

  it("names the from/to pair in the thrown error", () => {
    const id = makeRun("done");
    try {
      updateRunStatus(id, "running");
      throw new Error("expected updateRunStatus to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalRunStatusTransition);
      const e = err as IllegalRunStatusTransition;
      expect(e.from).toBe("done");
      expect(e.to).toBe("running");
      expect(e.message).toContain("done");
      expect(e.message).toContain("running");
    }
  });
});

// ===========================================================================
// Idempotent self-transitions are no-ops (runner re-checks status)
// ===========================================================================

describe("run status transitions — idempotent self-edges", () => {
  for (const status of ["scheduled", "running", "waiting", "pending", "done", "failed", "skipped", "killed"]) {
    it(`treats ${status} -> ${status} as a no-op`, () => {
      const id = makeRun(status);
      expect(() => updateRunStatus(id, status)).not.toThrow();
      expect(getRunById(id)!.status).toBe(status);
    });
  }
});
