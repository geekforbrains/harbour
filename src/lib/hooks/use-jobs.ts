"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped, type Scope } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

/**
 * List jobs in scope. `/api/jobs` is project-scoped and requires a projectId,
 * so this is only enabled when a project is active.
 */
export function useJobs(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<unknown[]>({
    queryKey: qk.jobs.list(s),
    queryFn: () => apiFetch<unknown[]>(scoped("/api/jobs", s)),
    enabled: (opts?.enabled ?? true) && !!s.projectId,
  });
}

export function useJob(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.jobs.detail(id),
    queryFn: () => apiFetch(`/api/jobs/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useJobRuns(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.jobs.runs(id),
    queryFn: () => apiFetch(`/api/jobs/${id}/runs`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

/** Create a workflow-only job (no agent). For agent jobs, POST to /api/agents/:id/jobs. */
export function useCreateWorkflowJob() {
  const qc = useQueryClient();
  const { projectId } = useScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ id: string }>(scoped("/api/jobs", { projectId }), { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.all }),
  });
}

/** Create an agent job under a specific agent. */
export function useCreateAgentJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; body: Record<string, unknown> }) =>
      apiFetch<{ id: string }>(`/api/agents/${vars.agentId}/jobs`, {
        method: "POST",
        body: vars.body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs.all }),
  });
}

export function useUpdateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: Record<string, unknown> }) =>
      apiFetch(`/api/jobs/${vars.id}`, { method: "PUT", body: vars.body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.jobs.all });
      qc.invalidateQueries({ queryKey: qk.runs.all });
      qc.invalidateQueries({ queryKey: qk.jobs.detail(vars.id) });
    },
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.jobs.all });
      qc.invalidateQueries({ queryKey: qk.runs.all });
    },
  });
}

/** Trigger a job to create an immediate run. */
export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { jobId: string; instructions?: string }) =>
      apiFetch(`/api/jobs/${vars.jobId}/trigger`, {
        method: "POST",
        body: vars.instructions ? { instructions: vars.instructions } : {},
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.runs.all });
      qc.invalidateQueries({ queryKey: qk.jobs.detail(vars.jobId) });
    },
  });
}
