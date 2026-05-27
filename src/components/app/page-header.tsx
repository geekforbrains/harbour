/**
 * The standard dashboard page title block: an `h1` + optional muted subtitle,
 * with an optional right-aligned action slot (buttons, etc.). Used on every
 * list/settings page so the title typography stays identical everywhere.
 *
 * `align` controls vertical alignment of the title block against the actions —
 * `center` (default) for single-line titles, `start` when the actions column
 * is taller than the title (e.g. the Users page).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  align = "center",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className={`flex ${align === "start" ? "items-start" : "items-center"} justify-between gap-4`}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/** The shared full-width "Loading..." placeholder used while a page's primary query resolves. */
export function PageLoading() {
  return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;
}
