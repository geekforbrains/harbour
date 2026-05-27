import Link from "next/link";

/**
 * The shared list-row container: a hairline-bordered card that links somewhere
 * and highlights on hover. Used across the jobs/docs/databases/env-vars/agents
 * lists and several detail-page sub-lists. Inner content is per-page.
 *
 * `align` matches the row's vertical alignment — `start` (default) for
 * multi-line rows with a metadata block, `center` for single-line rows.
 *
 * (Run rows use a distinct card treatment — see `run-row.tsx`.)
 */
export function RowLink({
  href,
  align = "start",
  className = "",
  children,
}: {
  href: string;
  align?: "start" | "center";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`flex ${align === "center" ? "items-center" : "items-start"} gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors${className ? ` ${className}` : ""}`}
    >
      {children}
    </Link>
  );
}
