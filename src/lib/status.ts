import {
  AlertCircle,
  Ban,
  CalendarClock,
  CheckCircle2,
  Clock,
  Hourglass,
  type LucideIcon,
  SkipForward,
  XCircle,
} from "lucide-react";

/**
 * Canonical run-status palette — the single source of truth for status color
 * across the app. RunStatusIcon, StatusDot, and StatusBadge all read from here
 * so the mapping can never drift.
 *
 * Design language: status is the primary color system (see the v2 design
 * language note). Each status gets a unique hue; class strings are written out
 * in full so Tailwind's JIT scanner picks them up (never build them dynamically).
 *
 *   fg     — icon / dot color
 *   bg     — tint background behind a boxed icon
 *   text   — badge text color (richer shade for legibility on the tint)
 */
export type RunStatusName =
  | "scheduled"
  | "running"
  | "waiting"
  | "pending"
  | "done"
  | "failed"
  | "killed"
  | "skipped";

export type StatusStyle = {
  label: string;
  icon: LucideIcon;
  fg: string;
  bg: string;
  text: string;
};

export const STATUS_STYLES: Record<string, StatusStyle> = {
  scheduled: {
    label: "Scheduled",
    icon: CalendarClock,
    fg: "text-slate-500",
    bg: "bg-slate-500/10",
    text: "text-slate-600 dark:text-slate-400",
  },
  running: {
    label: "Running",
    icon: Clock,
    fg: "text-blue-500",
    bg: "bg-blue-500/10",
    text: "text-blue-600 dark:text-blue-400",
  },
  waiting: {
    label: "Waiting",
    icon: AlertCircle,
    fg: "text-amber-500",
    bg: "bg-amber-500/10",
    text: "text-amber-600 dark:text-amber-400",
  },
  pending: {
    label: "Pending",
    icon: Hourglass,
    fg: "text-violet-500",
    bg: "bg-violet-500/10",
    text: "text-violet-600 dark:text-violet-400",
  },
  done: {
    label: "Done",
    icon: CheckCircle2,
    fg: "text-emerald-500",
    bg: "bg-emerald-500/10",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    fg: "text-red-500",
    bg: "bg-red-500/10",
    text: "text-red-600 dark:text-red-400",
  },
  killed: {
    label: "Killed",
    icon: Ban,
    fg: "text-orange-500",
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
  },
  skipped: {
    label: "Skipped",
    icon: SkipForward,
    fg: "text-muted-foreground",
    bg: "bg-muted",
    text: "text-muted-foreground",
  },
};

const FALLBACK: StatusStyle = {
  label: "Unknown",
  icon: Clock,
  fg: "text-muted-foreground",
  bg: "bg-muted",
  text: "text-muted-foreground",
};

export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? FALLBACK;
}
