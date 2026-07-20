import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advanceJobSchedule,
  createAgent,
  createJob,
  createProject,
  getJobById,
  getTimezone,
  setSetting,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { getNextRunTime } from "@/lib/schedule";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  setDb(freshDb());
  initializeSchema(getDb());
});

afterEach(() => {
  resetDb();
});

// A wall-clock schedule (daily 09:00), so the resolved timezone changes the
// absolute next_run_at. Interval schedules (`{"every":N}`) are timezone-agnostic
// and wouldn't exercise the instance-timezone path.
const DAILY_9AM = '{"days":[0,1,2,3,4,5,6],"time":"09:00"}';

describe("getTimezone", () => {
  it("returns the instance timezone when set", () => {
    setSetting("timezone", "America/New_York");
    expect(getTimezone()).toBe("America/New_York");
  });

  it("falls back to the host timezone when unset", () => {
    expect(getTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("scheduler honors the instance timezone", () => {
  it("createJob computes next_run_at in the instance timezone", () => {
    setSetting("timezone", "America/New_York");
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "A", undefined, { cli: "claude" });

    const jobNy = createJob(project.id, agent.id, { name: "NY", schedule: DAILY_9AM })!;
    expect(getJobById(jobNy.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "America/New_York"),
    );

    // Changing the instance timezone changes the absolute instant for the same
    // wall-clock schedule on subsequently created jobs.
    setSetting("timezone", "Asia/Tokyo");
    const jobTokyo = createJob(project.id, agent.id, { name: "Tokyo", schedule: DAILY_9AM })!;
    expect(getJobById(jobTokyo.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "Asia/Tokyo"),
    );
    expect(getJobById(jobNy.id)!.next_run_at).not.toBe(getJobById(jobTokyo.id)!.next_run_at);
  });

  it("advanceJobSchedule recomputes in the instance timezone", () => {
    setSetting("timezone", "America/New_York");
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "A", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "J", schedule: DAILY_9AM })!;

    advanceJobSchedule(job.id);
    expect(getJobById(job.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "America/New_York"),
    );
  });
});
