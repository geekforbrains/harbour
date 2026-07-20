"use client";

import { useApp } from "@/components/app/app-context";
import type { Scope } from "@/lib/api/client";

/**
 * The active project scope for the signed-in user. This is the single source of
 * truth the data-layer hooks read to scope every query/mutation. `projectId` is
 * `null` for the all-projects view.
 */
export function useScope(): Scope {
  const { activeProjectId } = useApp();
  return { projectId: activeProjectId };
}

/** Returns the raw activeProjectId (or null). */
export function useActiveProjectId() {
  const { activeProjectId } = useApp();
  return activeProjectId;
}
