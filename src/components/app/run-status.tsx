import { statusStyle } from "@/lib/status";

/** Boxed status icon (8x8 rounded-lg) used in list views */
export function RunStatusIcon({ status }: { status: string }) {
  const cfg = statusStyle(status);
  const Icon = cfg.icon;
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cfg.bg}`}>
      <Icon className={`h-4 w-4 ${cfg.fg}`} />
    </div>
  );
}

/** Inline status icon (3.5x3.5) for compact views */
export function StatusDot({ status }: { status: string }) {
  const cfg = statusStyle(status);
  const Icon = cfg.icon;
  return <Icon className={`h-3.5 w-3.5 ${cfg.fg}`} />;
}

/** Colored text badge */
export function StatusBadge({ status }: { status: string }) {
  const cfg = statusStyle(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      {status}
    </span>
  );
}
