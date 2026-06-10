"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type EnvVar = { id: string; name: string; pinned: number; [key: string]: unknown };

/** List env vars in scope (org-level + project-level when a project is active). */
export function useEnvVars(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<EnvVar[]>({
    queryKey: qk.envVars.list(s),
    queryFn: () => apiFetch<EnvVar[]>(scoped("/api/env-vars", s)),
    enabled: (opts?.enabled ?? true) && !!s.orgId,
  });
}

export function useEnvVar(id: string, opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: qk.envVars.detail(id),
    queryFn: () => apiFetch(`/api/env-vars/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useCreateEnvVar() {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<EnvVar>(scoped("/api/env-vars", scope), { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.envVars.all }),
  });
}

export function useEnvVarMutations(id: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.envVars.all });
    qc.invalidateQueries({ queryKey: qk.envVars.detail(id) });
  };
  return {
    update: useMutation({
      mutationFn: (body: Record<string, unknown>) =>
        apiFetch(`/api/env-vars/${id}`, { method: "PUT", body }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: () => apiFetch(`/api/env-vars/${id}`, { method: "DELETE" }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.envVars.all }),
    }),
    togglePin: useMutation({
      mutationFn: () => apiFetch(`/api/env-vars/${id}/pin`, { method: "POST" }),
      onSuccess: invalidate,
    }),
    revealValue: useMutation({
      mutationFn: () => apiFetch<{ value: string }>(`/api/env-vars/${id}/value`),
    }),
  };
}
