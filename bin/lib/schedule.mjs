// Port of src/lib/schedule.ts for the bin/ CLI (pure JS, no TS-build needed).
//
// The migrator must compute jobs.next_run_at the same way the running app does
// — the scheduler only claims jobs whose next_run_at is non-NULL and due — and
// must validate/normalize v1 schedule strings into the canonical JSON the v2
// app expects. The source module is self-contained, so this is a faithful
// 1:1 translation. `src/__tests__/migrate-schedule-parity.test.ts` asserts this
// port matches the TS original across a battery of schedules + timezones, so the
// two can never silently drift.
//
// Canonical schedule JSON shapes:
//   Interval: {"every": N}  — N is minutes
//   Weekly:   {"days": [0-6], "time": "HH:MM"} — days are 0=Sun..6=Sat, time is 24h

const DAY_NAMES = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function pad(n) {
  return String(n).padStart(2, "0");
}

function parseAmPm(hour, ampm) {
  if (ampm === "pm" && hour < 12) return hour + 12;
  if (ampm === "am" && hour === 12) return 0;
  return hour;
}

export function normalizeSchedule(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();

  // 1. Already canonical JSON?
  try {
    const parsed = JSON.parse(s);
    if ("every" in parsed && typeof parsed.every === "number" && parsed.every > 0) {
      return JSON.stringify({ every: parsed.every });
    }
    if (Array.isArray(parsed.days) && typeof parsed.time === "string") {
      const days = parsed.days
        .filter((d) => typeof d === "number" && d >= 0 && d <= 6)
        .sort((a, b) => a - b);
      if (days.length > 0 && /^\d{2}:\d{2}$/.test(parsed.time)) {
        return JSON.stringify({ days, time: parsed.time });
      }
    }
    return null;
  } catch {
    // Not JSON — continue
  }

  const lower = s.toLowerCase();

  // 2. "every N unit(s)"
  const everyMatch = lower.match(/^every\s+(\d+)\s+(second|minute|hour|day|week)s?$/);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const multiplier = { second: 1 / 60, minute: 1, hour: 60, day: 1440, week: 10080 };
    const mins = Math.round(n * multiplier[everyMatch[2]]);
    return mins > 0 ? JSON.stringify({ every: mins }) : null;
  }

  // 3. "hourly" or "hourly at :MM"
  const hourlyMatch = lower.match(/^hourly(?:\s+at\s+:(\d{2}))?$/);
  if (hourlyMatch) {
    return JSON.stringify({ every: 60 });
  }

  // 4. "daily" or "daily at HH:MM/Ham/Hpm"
  const dailyMatch = lower.match(/^daily(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (dailyMatch) {
    const hour = parseAmPm(dailyMatch[1] ? parseInt(dailyMatch[1], 10) : 0, dailyMatch[3]);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    return JSON.stringify({ days: ALL_DAYS, time: `${pad(hour)}:${pad(minute)}` });
  }

  // 5. "weekly [on <day>] [at HH:MM]"
  const weeklyMatch = lower.match(
    /^weekly(?:\s+on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
  );
  if (weeklyMatch) {
    const day = weeklyMatch[1] ? DAY_NAMES[weeklyMatch[1]] : 1;
    const hour = parseAmPm(weeklyMatch[2] ? parseInt(weeklyMatch[2], 10) : 0, weeklyMatch[4]);
    const minute = weeklyMatch[3] ? parseInt(weeklyMatch[3], 10) : 0;
    return JSON.stringify({ days: [day], time: `${pad(hour)}:${pad(minute)}` });
  }

  // 6. Cron expressions (common patterns only)
  const parts = s.split(/\s+/);
  if (parts.length === 5) {
    const [cronMin, cronHr, , , cronDow] = parts;

    const minInterval = cronMin.match(/^\*\/(\d+)$/);
    if (minInterval && cronHr === "*") {
      return JSON.stringify({ every: parseInt(minInterval[1], 10) });
    }

    const hrInterval = cronHr.match(/^\*\/(\d+)$/);
    if (hrInterval && cronMin === "0") {
      return JSON.stringify({ every: parseInt(hrInterval[1], 10) * 60 });
    }

    const h = parseInt(cronHr, 10);
    const m = parseInt(cronMin, 10);
    if (!Number.isNaN(h) && !Number.isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const time = `${pad(h)}:${pad(m)}`;
      if (cronDow === "*") return JSON.stringify({ days: ALL_DAYS, time });
      const days = parseCronDays(cronDow);
      if (days.length > 0) return JSON.stringify({ days, time });
    }
  }

  return null;
}

function parseCronDays(dow) {
  const days = new Set();
  for (const part of dow.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      for (let i = parseInt(range[1], 10); i <= parseInt(range[2], 10); i++) days.add(i);
    } else if (/^\d$/.test(part)) {
      days.add(parseInt(part, 10));
    }
  }
  return [...days].sort((a, b) => a - b);
}

function nowInTz(tz, from) {
  const now = from || new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    realNow: now,
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    weekday: weekdayMap[get("weekday")] ?? 0,
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

function tzDateToEpoch(tz, year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const inTz = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const get = (type) => parseInt(inTz.find((p) => p.type === type)?.value || "0", 10);
  const tzHour = get("hour");
  const tzMinute = get("minute");
  const tzDay = get("day");

  const dayDiff = day - tzDay;
  const hourDiff = hour - tzHour;
  const minuteDiff = minute - tzMinute;
  const offsetMs = (dayDiff * 86400 + hourDiff * 3600 + minuteDiff * 60) * 1000;

  return Math.floor((probe.getTime() + offsetMs) / 1000);
}

export function getNextRunTime(schedule, from, timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = from || new Date();

  try {
    const parsed = JSON.parse(schedule);

    if ("every" in parsed && typeof parsed.every === "number") {
      const ms = parsed.every * 60000;
      const next = Math.ceil(now.getTime() / ms) * ms;
      return Math.floor(next / 1000);
    }

    if (parsed.days && parsed.time) {
      const [h, m] = parsed.time.split(":").map(Number);
      const tn = nowInTz(tz, now);
      const sortedDays = parsed.days.slice().sort((a, b) => a - b);

      for (let offset = 0; offset <= 7; offset++) {
        const candidateWeekday = (tn.weekday + offset) % 7;
        if (!sortedDays.includes(candidateWeekday)) continue;

        const candidateDate = new Date(Date.UTC(tn.year, tn.month - 1, tn.day + offset));
        const cy = candidateDate.getUTCFullYear();
        const cm = candidateDate.getUTCMonth() + 1;
        const cd = candidateDate.getUTCDate();
        const epoch = tzDateToEpoch(tz, cy, cm, cd, h, m);

        if (epoch > Math.floor(now.getTime() / 1000)) return epoch;
      }

      const wrapOffset = (sortedDays[0] - tn.weekday + 7) % 7 || 7;
      const wrapDate = new Date(Date.UTC(tn.year, tn.month - 1, tn.day + wrapOffset));
      return tzDateToEpoch(
        tz,
        wrapDate.getUTCFullYear(),
        wrapDate.getUTCMonth() + 1,
        wrapDate.getUTCDate(),
        h,
        m,
      );
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

export function isValidSchedule(schedule) {
  return normalizeSchedule(schedule) !== null;
}
