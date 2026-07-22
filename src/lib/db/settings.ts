import { getDb } from "./schema";

const SETTING_KEYS = ["timezone", "recent_runs_limit", "recent_runs_per_job"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function getSetting(key: SettingKey): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: SettingKey, value: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
  ).run(key, value, value);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string;
    value: string;
  }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (isSettingKey(row.key)) result[row.key] = row.value;
  }
  return result;
}

/**
 * The instance timezone — the single source for scheduling and run titles.
 * Falls back to the host timezone when unset.
 */
export function getTimezone(): string {
  return getSetting("timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function getRecentRunsLimit(): number {
  const val = getSetting("recent_runs_limit");
  const n = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * Max successful (`done`) runs one job may occupy in the dashboard's
 * recent-runs list, so a chatty job can't bury everything else. Failed and
 * killed runs are never capped. See listRecentRuns.
 */
export function getRecentRunsPerJob(): number {
  const val = getSetting("recent_runs_per_job");
  const n = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}
