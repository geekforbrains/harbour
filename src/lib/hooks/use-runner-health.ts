"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { useScope } from "@/lib/hooks/use-project-filter";

/** A placement with queued work that no live runner is serving. */
export type StalledPlacement = { placement: string; count: number };

/**
 * The absent-runner surface for the active scope. Polls a touch slower than the
 * run lists — a stalled placement is a "nobody's home" condition, not a hot path.
 */
export function useRunnerHealth(opts?: { enabled?: boolean }) {
  const { orgId } = useScope();
  const s: Scope = useScope();
  return useQuery<{ stalled: StalledPlacement[] }>({
    queryKey: ["runner-health", orgId, s.projectId ?? null],
    queryFn: () => apiFetch<{ stalled: StalledPlacement[] }>(scoped("/api/runs/health", s)),
    enabled: (opts?.enabled ?? true) && !!orgId,
    refetchInterval: 15_000,
  });
}
