"use client";

import { useApp } from "@/components/app/app-context";

/**
 * Returns a scope query string. Project scope wins; otherwise workspace scope
 * filters all records linked through projects in that workspace.
 */
export function useProjectFilter() {
  const { activeProjectId, activeWorkspaceId } = useApp();
  if (activeProjectId) return `?projectId=${activeProjectId}`;
  if (activeWorkspaceId) return `?workspaceId=${activeWorkspaceId}`;
  return "";
}

/** Returns the raw activeProjectId (or null) */
export function useActiveProjectId() {
  const { activeProjectId } = useApp();
  return activeProjectId;
}

/** Returns the raw activeWorkspaceId (or null) */
export function useActiveWorkspaceId() {
  const { activeWorkspaceId } = useApp();
  return activeWorkspaceId;
}
