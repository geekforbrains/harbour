import { describe, expect, it } from "vitest";
import * as original from "@/lib/schedule";
// The migrator (bin/lib/schedule.mjs) ports getNextRunTime/normalizeSchedule so
// the CLI can compute jobs.next_run_at without a TS build. This test locks that
// port to the real TS implementation — if src/lib/schedule.ts changes and the
// port doesn't, these assertions fail and the two can't silently drift.
import * as ported from "../../bin/lib/schedule.mjs";

const SCHEDULES = [
  '{"every":5}',
  '{"every":60}',
  '{"every":1440}',
  '{"days":[1,2,3,4,5],"time":"09:00"}',
  '{"days":[0],"time":"03:00"}',
  '{"days":[6],"time":"23:30"}',
  '{"days":[2,4],"time":"12:00"}',
  "not valid json",
  '{"bogus":true}',
];

const NORMALIZE_INPUTS = [
  "every 5 minutes",
  "every 2 hours",
  "every 1 week",
  "daily",
  "daily at 9am",
  "daily at 17:30",
  "weekly",
  "weekly on monday at 14:30",
  "hourly",
  "hourly at :15",
  "0 9 * * 1-5",
  "*/15 * * * *",
  "0 */2 * * *",
  "30 8 * * 1,3,5",
  '{"every":10}',
  '{"days":[1,2],"time":"08:00"}',
  "complete garbage",
  "",
];

const TIMEZONES = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"];
// Fixed reference instant so the comparison is deterministic.
const FROM = new Date("2026-03-15T12:34:56Z");

describe("migrate schedule port parity", () => {
  it("normalizeSchedule matches the TS original", () => {
    for (const input of NORMALIZE_INPUTS) {
      expect(ported.normalizeSchedule(input), `normalize ${JSON.stringify(input)}`).toBe(
        original.normalizeSchedule(input),
      );
    }
  });

  it("getNextRunTime matches the TS original across timezones", () => {
    for (const tz of TIMEZONES) {
      for (const sched of SCHEDULES) {
        expect(ported.getNextRunTime(sched, FROM, tz), `next ${sched} @ ${tz}`).toBe(
          original.getNextRunTime(sched, FROM, tz),
        );
      }
    }
  });
});
