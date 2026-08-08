import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createJob,
  createProject,
  createRun,
  createTable,
  deleteProject,
  insertRows,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { runUploadsDir } from "@/lib/paths";

// ON DELETE CASCADE clears the metadata rows beneath a project, but two things
// live outside the FK graph and leak: the physical `t_*` SQLite tables that
// hold agent-written data, and the on-disk uploads/runs/<id>/ directories.
// deleteJob and deleteAgent already clean the latter up — deleteProject is the
// one destructive path that didn't.

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "hb-project-del-"));
  process.env.HARBOUR_HOME = home;
});

afterAll(() => {
  delete process.env.HARBOUR_HOME;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
});

function physicalTables(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't\\_%' ESCAPE '\\'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("deleteProject cleanup", () => {
  it("drops the project's physical t_* tables, not just their metadata rows", () => {
    const project = createProject("Site")!;
    const table = createTable(project.id, "leads", [{ name: "email", type: "TEXT" }]);
    insertRows(table.id, [{ email: "a@b.com" }]);

    expect(physicalTables()).toContain(table.table_name);

    deleteProject(project.id);

    expect(physicalTables()).not.toContain(table.table_name);
    expect(getDb().prepare(`SELECT COUNT(*) as n FROM tables`).get()).toEqual({ n: 0 });
  });

  it("removes the on-disk attachment dirs of the project's runs", () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, {
      name: "Nightly",
      instructions: "do the thing",
      schedule: '{"every":60}',
    })!;
    const run = createRun(job.id, agent.id)!;

    const dir = runUploadsDir(run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "report.txt"), "payload");
    expect(fs.existsSync(dir)).toBe(true);

    deleteProject(project.id);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves another project's tables and attachments untouched", () => {
    const doomed = createProject("Doomed")!;
    const keeper = createProject("Keeper")!;
    const doomedTable = createTable(doomed.id, "a", [{ name: "c", type: "TEXT" }]);
    const keeperTable = createTable(keeper.id, "b", [{ name: "c", type: "TEXT" }]);

    const agent = createAgent(keeper.id, "Dev");
    const job = createJob(keeper.id, agent.id, {
      name: "Keep",
      instructions: "keep",
      schedule: '{"every":60}',
    })!;
    const keeperRun = createRun(job.id, agent.id)!;
    const keeperDir = runUploadsDir(keeperRun.id);
    fs.mkdirSync(keeperDir, { recursive: true });

    deleteProject(doomed.id);

    expect(physicalTables()).not.toContain(doomedTable.table_name);
    expect(physicalTables()).toContain(keeperTable.table_name);
    expect(fs.existsSync(keeperDir)).toBe(true);
  });
});
