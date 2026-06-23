/**
 * Agent identity colors.
 *
 * In the v2 "monochrome chrome, chromatic signal" design, the interface
 * chrome is neutral and color carries meaning. Agents get a stable identity
 * color derived from their name (or id), so the same agent reads the same
 * everywhere — a colored dot next to its name, its avatar ring, etc.
 *
 * The palette deliberately leans on hues that aren't load-bearing for run
 * status (status owns green/red/amber/blue/violet/orange), so an agent dot
 * is never mistaken for a status.
 */

// Sixteen hues stepped around the wheel so neighbours stay perceptually
// distinct even at dot size. The first eight (orange → lime → teal → sky →
// indigo → purple → fuchsia → pink) are the original auto-assign palette and
// MUST keep their order — the name hash maps over them, so reordering would
// shift every unstored agent's color. The second eight fill the gaps for
// explicit user choice. The dot's position (in the metadata line, never the
// boxed status slot) keeps it from being read as a status. Tuned for light
// and dark surfaces.
export const AGENT_COLORS = [
  "#f97316", // orange
  "#84cc16", // lime
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#ef4444", // red
  "#f59e0b", // amber
  "#eab308", // yellow
  "#22c55e", // green
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
] as const;

// The hash fallback only draws from the original eight hues — they're biased
// away from red / amber / emerald, the most "loaded" status hues, so an
// auto-assigned agent dot is never mistaken for a status.
const HASH_SPAN = 8;

/** Stable FNV-1a hash so the same string always maps to the same color. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Hex color for an agent, derived from its name.
 *
 * Reduces across the *full* 32-bit hash range rather than `% n` — a power-of-two
 * modulo would only use the low bits, which cluster badly for short similar
 * names (Harbour / Hearsay / Tarot Journal all collided under `% 8`).
 *
 * Note: with a fixed palette, hashing can't guarantee zero collisions between
 * distinct agents — it's the fallback for agents without a stored color.
 * Prefer `resolveAgentColor` when the stored column is available.
 */
export function agentColor(key: string | null | undefined): string {
  if (!key) return "#71717a"; // neutral zinc for workflows/no-agent rows
  const idx = Math.floor((hashString(key) / 0x100000000) * HASH_SPAN);
  return AGENT_COLORS[idx];
}

/**
 * Hex color for an agent: the stored (user-chosen) color when set, otherwise
 * the stable name-hash fallback.
 */
export function resolveAgentColor(
  color: string | null | undefined,
  nameKey: string | null | undefined,
): string {
  return color || agentColor(nameKey);
}
