"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

/** List jobs — the active project's, or all projects when none is active. */
export function useJobs(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<unknown[]>({
    queryKey: qk.jobs.list(s),
    queryFn: () => apiFetch<unknown[]>(scoped("/api/jobs", s)),
    enabled: opts?.enabled ?? true,
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

/**
 * Create a deterministic workflow (no agent). For agent jobs, POST to
 * /api/agents/:id/jobs. Creation requires a concrete project: the active one,
 * or a `projectId` in the body (which takes precedence).
 */
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

/** Link/unlink docs, env vars, and tables to a job. All invalidate the job detail. */
export function useJobLinkMutations(id: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.jobs.detail(id) });
  return {
    linkDoc: useMutation({
      mutationFn: (docId: string) =>
        apiFetch(`/api/jobs/${id}/docs`, { method: "POST", body: { docId } }),
      onSuccess: invalidate,
    }),
    unlinkDoc: useMutation({
      mutationFn: (docId: string) =>
        apiFetch(`/api/jobs/${id}/docs/${docId}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
    linkEnvVar: useMutation({
      mutationFn: (envVarId: string) =>
        apiFetch(`/api/jobs/${id}/env-vars`, { method: "POST", body: { envVarId } }),
      onSuccess: invalidate,
    }),
    unlinkEnvVar: useMutation({
      mutationFn: (envVarId: string) =>
        apiFetch(`/api/jobs/${id}/env-vars/${envVarId}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
    linkTable: useMutation({
      mutationFn: (tableId: string) =>
        apiFetch(`/api/jobs/${id}/tables`, { method: "POST", body: { tableId } }),
      onSuccess: invalidate,
    }),
    unlinkTable: useMutation({
      mutationFn: (tableId: string) =>
        apiFetch(`/api/jobs/${id}/tables/${tableId}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
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
