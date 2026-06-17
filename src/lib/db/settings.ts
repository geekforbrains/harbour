import { getDb } from "./schema";

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
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
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function getTimezone(): string {
  return getSetting("timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Timezone for scheduling an org's jobs: the org's own setting if present, else
 * the instance-global timezone (which itself falls back to the host tz). The
 * scheduler resolves each job's timezone from its org so orgs in different
 * regions get correct wall-clock firing times.
 */
export function getOrgTimezone(orgId: string): string {
  const db = getDb();
  const row = db.prepare(`SELECT settings FROM orgs WHERE id = ?`).get(orgId) as
    | { settings: string }
    | undefined;
  if (row?.settings) {
    try {
      const parsed = JSON.parse(row.settings) as { timezone?: string };
      if (parsed.timezone?.trim()) return parsed.timezone.trim();
    } catch {
      // Malformed settings JSON — fall through to the instance default.
    }
  }
  return getTimezone();
}

export function getRecentRunsLimit(): number {
  const val = getSetting("recent_runs_limit");
  const n = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

// Video processing settings

export function isVideoAutoProcessEnabled(): boolean {
  return getSetting("video_auto_process") === "true";
}

export function getVideoScreenshotInterval(): number {
  const val = getSetting("video_screenshot_interval");
  const n = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export type TranscriptProvider = "off" | "whisper" | "openai" | "gemini";

export function getVideoTranscriptProvider(): TranscriptProvider {
  const val = getSetting("video_transcript_provider");
  if (val === "whisper" || val === "openai" || val === "gemini") return val;
  return "off";
}

export function getVideoTranscriptApiKey(provider: "openai" | "gemini"): string | null {
  const key = provider === "openai" ? "video_openai_api_key" : "video_gemini_api_key";
  return getSetting(key);
}

/** Settings keys that contain sensitive values and should be masked in API responses */
const SENSITIVE_SETTINGS = new Set(["video_openai_api_key", "video_gemini_api_key"]);

export function isSensitiveSetting(key: string): boolean {
  return SENSITIVE_SETTINGS.has(key);
}

export function maskSettingValue(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `••••••••${value.slice(-4)}`;
}
