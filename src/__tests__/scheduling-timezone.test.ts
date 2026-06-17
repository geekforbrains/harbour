import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advanceJobSchedule,
  createAgent,
  createJob,
  createOrg,
  createProject,
  getJobById,
  getOrgTimezone,
  getTimezone,
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
// and wouldn't exercise the org-timezone path.
const DAILY_9AM = '{"days":[0,1,2,3,4,5,6],"time":"09:00"}';

function setOrgTimezone(orgId: string, tz: string) {
  getDb()
    .prepare(`UPDATE orgs SET settings = ? WHERE id = ?`)
    .run(JSON.stringify({ timezone: tz }), orgId);
}

describe("getOrgTimezone", () => {
  it("returns the org's own timezone when set", () => {
    const org = createOrg("Acme")!;
    setOrgTimezone(org.id, "America/New_York");
    expect(getOrgTimezone(org.id)).toBe("America/New_York");
  });

  it("falls back to the instance default when the org has none", () => {
    const org = createOrg("Acme")!;
    // Fresh org settings default to '{}', so no per-org timezone is stored.
    expect(getOrgTimezone(org.id)).toBe(getTimezone());
  });
});

describe("scheduler honors each org's timezone", () => {
  it("createJob computes next_run_at in the owning org's timezone", () => {
    const orgNy = createOrg("NY")!;
    const orgTokyo = createOrg("Tokyo")!;
    setOrgTimezone(orgNy.id, "America/New_York");
    setOrgTimezone(orgTokyo.id, "Asia/Tokyo");
    const projNy = createProject(orgNy.id, "Site")!;
    const projTokyo = createProject(orgTokyo.id, "Site")!;
    const agentNy = createAgent(projNy.id, "A", undefined, { cli: "claude" });
    const agentTokyo = createAgent(projTokyo.id, "A", undefined, { cli: "claude" });

    const jobNy = createJob(projNy.id, agentNy.id, { name: "J", schedule: DAILY_9AM })!;
    const jobTokyo = createJob(projTokyo.id, agentTokyo.id, { name: "J", schedule: DAILY_9AM })!;

    expect(getJobById(jobNy.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "America/New_York"),
    );
    expect(getJobById(jobTokyo.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "Asia/Tokyo"),
    );
    // Same wall-clock schedule, different zones → different absolute instants.
    expect(getJobById(jobNy.id)!.next_run_at).not.toBe(getJobById(jobTokyo.id)!.next_run_at);
  });

  it("advanceJobSchedule recomputes in the owning org's timezone", () => {
    const org = createOrg("NY")!;
    setOrgTimezone(org.id, "America/New_York");
    const project = createProject(org.id, "Site")!;
    const agent = createAgent(project.id, "A", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "J", schedule: DAILY_9AM })!;

    advanceJobSchedule(job.id);
    expect(getJobById(job.id)!.next_run_at).toBe(
      getNextRunTime(DAILY_9AM, undefined, "America/New_York"),
    );
  });
});
