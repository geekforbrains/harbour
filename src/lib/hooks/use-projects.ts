"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@/components/app/app-context";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

/** List all projects. */
export function useProjects(opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery<Project[]>({
    queryKey: qk.projects.list(),
    queryFn: () => apiFetch<Project[]>("/api/projects"),
    enabled: opts?.enabled ?? true,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Project>("/api/projects", { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects.all }),
  });
}
