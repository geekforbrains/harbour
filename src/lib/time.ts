export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatTimestamp(ts: number | null, timezone?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone } : {};
  const isToday = d.toLocaleDateString("en-US", opts) === now.toLocaleDateString("en-US", opts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...opts });
  if (isToday) return `Today at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toLocaleDateString("en-US", opts) === tomorrow.toLocaleDateString("en-US", opts))
    return `Tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", ...opts })} at ${time}`;
}
