"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped, type Scope } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type DatabaseEntry = { id: string; name: string; [key: string]: unknown };

/** List databases in scope (org-level + project-level when a project is active). */
export function useDatabases(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<DatabaseEntry[]>({
    queryKey: qk.databases.list(s),
    queryFn: () => apiFetch<DatabaseEntry[]>(scoped("/api/databases", s)),
    enabled: (opts?.enabled ?? true) && !!s.orgId,
  });
}

export function useDatabase(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.databases.detail(id),
    queryFn: () => apiFetch(`/api/databases/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useDatabaseRows(
  id: string,
  page: number,
  pageSize: number,
  opts?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: qk.databases.rows(id, page),
    queryFn: () =>
      apiFetch(`/api/databases/${id}/rows?limit=${pageSize}&offset=${page * pageSize}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useDeleteDatabase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/databases/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.databases.all }),
  });
}
