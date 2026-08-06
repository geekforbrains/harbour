/** Compact count formatting for run metrics (token totals). */

/**
 * Compact token count: `999`, `45.2k`, `1.2M`. Metrics default to 0 for runs
 * that never reported usage — render that (and null) as an em-dash, not "0".
 */
export function formatTokens(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${compact(n / 1000)}k`;
  return `${compact(n / 1_000_000)}M`;
}

/** One decimal place, with a trailing .0 trimmed (45.0 → "45"). */
function compact(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
