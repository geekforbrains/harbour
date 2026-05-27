"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped, type Scope } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";
import type { Project } from "@/components/app/app-context";

/** List projects in the active org. */
export function useProjects(scope?: Scope, opts?: { enabled?: boolean; refetchInterval?: number }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<Project[]>({
    queryKey: qk.projects.list(s),
    queryFn: () => apiFetch<Project[]>(scoped("/api/projects", { orgId: s.orgId })),
    // Always gate on an org being selected — /api/projects 403s without one.
    enabled: (opts?.enabled ?? true) && !!s.orgId,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  const { orgId } = useScope();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Project>(scoped("/api/projects", { orgId }), { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects.all }),
  });
}

/** Link/unlink an entity to a project (PATCH) or delete a project (DELETE). */
export function useProjectMutations() {
  const qc = useQueryClient();
  return {
    link: useMutation({
      mutationFn: (vars: { projectId: string; type: string; targetId: string }) =>
        apiFetch(`/api/projects/${vars.projectId}`, {
          method: "PATCH",
          body: { action: "link", type: vars.type, targetId: vars.targetId },
        }),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: qk.projects.all });
        qc.invalidateQueries({ queryKey: qk.agents.all });
        qc.invalidateQueries({ queryKey: qk.jobs.all });
        qc.invalidateQueries({ queryKey: qk.docs.all });
        qc.invalidateQueries({ queryKey: qk.envVars.all });
        qc.invalidateQueries({ queryKey: qk.databases.all });
      },
    }),
    remove: useMutation({
      mutationFn: (projectId: string) =>
        apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects.all }),
    }),
  };
}
