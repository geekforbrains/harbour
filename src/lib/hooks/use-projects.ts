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

// v2 NOTE: the v1 PATCH link/unlink action is gone (per-project link tables were
// replaced by a single project_id column, and no entity PUT route accepts a
// project_id reparent). Entities are placed in a project at creation time via
// the scoped POST. If reparenting is needed later, add it to the data layer and
// restore the "Add Existing" dialogs that referenced this.
/** Project lifecycle mutations (delete = soft-archive). */
export function useProjectMutations() {
  const qc = useQueryClient();
  return {
    remove: useMutation({
      mutationFn: (projectId: string) =>
        apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects.all }),
    }),
  };
}
