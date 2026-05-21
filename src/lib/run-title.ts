import { getTimezone } from "./db/settings";

/**
 * Initial run title shown in the UI before the agent overrides it. Format is
 * `${jobName} · ${HH:MMam}` in the system timezone so two runs of the same
 * job are distinguishable at a glance.
 */
export function defaultRunTitle(jobName: string, unixSeconds: number, timezone?: string): string {
  const tz = timezone || getTimezone();
  const time = new Date(unixSeconds * 1000).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).toLowerCase().replace(/\s/g, "");
  return `${jobName} · ${time}`;
}

export const MAX_TITLE_LENGTH = 80;

/**
 * Normalize an agent-supplied title. Returns null when the result is unusable
 * (empty after trimming). Callers should reject with 400 in that case.
 */
export function normalizeTitle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TITLE_LENGTH);
}
