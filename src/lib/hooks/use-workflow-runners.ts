"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type WorkflowRunner = {
  id: string;
  org_id: string;
  name: string;
  labels: string[];
  enabled: number;
  /** Unix seconds of the runner's last poll, or null if it has never polled. */
  last_polled_at: number | null;
  created_at: number;
  updated_at: number;
};

/**
 * List the active org's workflow runners. Org-scoped — the GET route is
 * `withOrgAuth` and reads only `?orgId`, so this drops any project filter and is
 * enabled only when an org is active.
 */
export function useWorkflowRunners(opts?: { enabled?: boolean }) {
  const { orgId } = useScope();
  const s: Scope = { orgId };
  return useQuery<WorkflowRunner[]>({
    queryKey: qk.workflowRunners.list(s),
    queryFn: () => apiFetch<WorkflowRunner[]>(scoped("/api/workflow-runners", s)),
    enabled: (opts?.enabled ?? true) && !!orgId,
  });
}
