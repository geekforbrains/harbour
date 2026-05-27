"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped, type Scope } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type Agent = {
  id: string;
  name: string;
  description?: string | null;
  cli: string | null;
  model: string | null;
  thinking: string | null;
  color?: string | null;
  eager: number | null;
  remote?: number | null;
  [key: string]: unknown;
};

/**
 * List agents in scope. The `/api/agents` route is project-scoped and requires
 * a projectId, so this is only enabled when a project is active.
 */
export function useAgents(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<Agent[]>({
    queryKey: qk.agents.list(s),
    queryFn: () => apiFetch<Agent[]>(scoped("/api/agents", s)),
    enabled: (opts?.enabled ?? true) && !!s.projectId,
  });
}

export function useAgent(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.agents.detail(id),
    queryFn: () => apiFetch(`/api/agents/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useAgentJobs(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.agents.jobs(id),
    queryFn: () => apiFetch(`/api/agents/${id}/jobs`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useAgentRuns(id: string, limit = 50, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.agents.runs(id),
    queryFn: () => apiFetch(`/api/agents/${id}/runs?limit=${limit}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  const { projectId } = useScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<Agent & { apiKey?: string }>(scoped("/api/agents", { projectId }), {
        method: "POST",
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents.all }),
  });
}

export function useUpdateAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/agents/${id}`, { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents.all }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agents.all });
      qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });
}
