import type { ReactNode } from "react";

/**
 * Wraps an action so a native-title tooltip shows on hover. A disabled button
 * suppresses pointer events, so a hint explaining *why* it's unavailable has to
 * live on a wrapping element rather than the button itself. When `hint` is
 * empty the children render unwrapped (no idle tooltip on enabled actions).
 */
export function ActionTooltip({ hint, children }: { hint?: string; children: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <span title={hint} className="inline-block">
      {children}
    </span>
  );
}
