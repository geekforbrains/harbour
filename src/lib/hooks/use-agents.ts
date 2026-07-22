"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type Agent = {
  id: string;
  name: string;
  /** Workspace folder segment — assigned at creation, immutable on rename. */
  slug?: string | null;
  description?: string | null;
  cli: string | null;
  model: string | null;
  thinking: string | null;
  llm_connection_id?: string | null;
  llm_connection?: {
    id: string;
    name: string;
    kind: string;
    provider_id: string;
  } | null;
  color?: string | null;
  eager: number | null;
  remote?: number | null;
  project_name?: string;
  [key: string]: unknown;
};

/** List agents — the active project's, or all projects when none is active. */
export function useAgents(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<Agent[]>({
    queryKey: qk.agents.list(s),
    queryFn: () => apiFetch<Agent[]>(scoped("/api/agents", s)),
    enabled: opts?.enabled ?? true,
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

/** Is a runner already live for this agent's placement + CLI? Drives the
 * "Agent Created" dialog's copy — skip the setup guidance when one's already
 * listening. */
export function useAgentRunnerStatus(id: string, opts?: { enabled?: boolean }) {
  return useQuery<{ live: boolean }>({
    queryKey: qk.agents.runnerStatus(id),
    queryFn: () => apiFetch<{ live: boolean }>(`/api/agents/${id}/runner-status`),
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
