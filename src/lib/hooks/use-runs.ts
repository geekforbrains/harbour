"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunRowData } from "@/components/app/run-row";
import { apiFetch, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

type RunsBundle = {
  scheduled: RunRowData[];
  running: RunRowData[];
  waiting: RunRowData[];
  recent: RunRowData[];
};

/** The Runs dashboard bundle (scheduled/running/waiting/recent) for the active scope. */
export function useRuns(opts?: { enabled?: boolean; refetchInterval?: number }) {
  const scope = useScope();
  return useQuery<RunsBundle>({
    queryKey: qk.runs.list(scope),
    queryFn: () => apiFetch<RunsBundle>(scoped("/api/runs", scope)),
    enabled: (opts?.enabled ?? true) && !!scope.orgId,
    refetchInterval: opts?.refetchInterval,
  });
}

/** Count of waiting runs (sidebar badge). */
export function useWaitingCount(opts?: { enabled?: boolean; refetchInterval?: number }) {
  const scope = useScope();
  return useQuery<number>({
    queryKey: qk.runs.filter("waiting-count", scope),
    queryFn: async () => {
      const data = await apiFetch<unknown>(scoped("/api/runs?filter=waiting", scope));
      return Array.isArray(data) ? data.length : 0;
    },
    enabled: (opts?.enabled ?? true) && !!scope.orgId,
    refetchInterval: opts?.refetchInterval,
  });
}

/** Paginated run history. Pass extra filter params already serialized into `query`. */
export function useRunsHistory(query: string, opts?: { enabled?: boolean }) {
  const scope = useScope();
  return useQuery({
    queryKey: [...qk.runs.history(scope), query],
    queryFn: () => apiFetch(scoped(`/api/runs/history${query ? `?${query}` : ""}`, scope)),
    enabled: (opts?.enabled ?? true) && !!scope.orgId,
  });
}

export function useRun(id: string, opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: qk.runs.detail(id),
    queryFn: () => apiFetch(`/api/runs/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useRunMutations(id: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.runs.all });
    qc.invalidateQueries({ queryKey: qk.runs.detail(id) });
  };
  return {
    retry: useMutation({
      mutationFn: () => apiFetch(`/api/runs/${id}/retry`, { method: "POST" }),
      onSuccess: invalidate,
    }),
    kill: useMutation({
      mutationFn: () => apiFetch(`/api/runs/${id}/kill`, { method: "POST" }),
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: (status: string) =>
        apiFetch(`/api/runs/${id}/status`, { method: "PUT", body: { status } }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: () => apiFetch(`/api/runs/${id}`, { method: "DELETE" }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.runs.all }),
    }),
    addActivity: useMutation({
      mutationFn: (body: Record<string, unknown>) =>
        apiFetch(`/api/runs/${id}/activity`, { method: "POST", body }),
      onSuccess: invalidate,
    }),
  };
}
