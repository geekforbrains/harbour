"use client";

import { useApp } from "@/components/app/app-context";
import type { Scope } from "@/lib/api/client";

/**
 * The active org/project scope for the signed-in user. This is the single
 * source of truth the data-layer hooks read to scope every query/mutation.
 *
 *  - `orgId`     — active org (from the `harbour_org` cookie). `null` only in the
 *                  instance-admin "All orgs" view.
 *  - `projectId` — active project filter, or `null` for org-wide.
 */
export function useScope(): Scope {
  const { activeOrgId, activeProjectId } = useApp();
  return { orgId: activeOrgId, projectId: activeProjectId };
}

/** Returns a URLSearchParams string like "?projectId=abc" or "" if no project is active. */
export function useProjectFilter() {
  const { activeProjectId } = useApp();
  return activeProjectId ? `?projectId=${activeProjectId}` : "";
}

/** Returns the raw activeProjectId (or null). */
export function useActiveProjectId() {
  const { activeProjectId } = useApp();
  return activeProjectId;
}

/** Returns the raw activeOrgId (or null). */
export function useActiveOrgId() {
  const { activeOrgId } = useApp();
  return activeOrgId;
}
