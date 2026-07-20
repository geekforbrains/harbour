"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type TableEntry = {
  id: string;
  name: string;
  pinned: number;
  project_name?: string;
  [key: string]: unknown;
};

/** List tables — the active project's, or all projects when none is active. */
export function useTables(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<TableEntry[]>({
    queryKey: qk.tables.list(s),
    queryFn: () => apiFetch<TableEntry[]>(scoped("/api/tables", s)),
    enabled: opts?.enabled ?? true,
  });
}

export function useTable(id: string, opts?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: qk.tables.detail(id),
    queryFn: () => apiFetch(`/api/tables/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useTableRows(
  id: string,
  page: number,
  pageSize: number,
  opts?: { enabled?: boolean; refetchInterval?: number },
) {
  return useQuery({
    queryKey: qk.tables.rows(id, page),
    queryFn: () => apiFetch(`/api/tables/${id}/rows?limit=${pageSize}&offset=${page * pageSize}`),
    enabled: (opts?.enabled ?? true) && !!id,
    refetchInterval: opts?.refetchInterval,
  });
}

export function useDeleteTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tables/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tables.all }),
  });
}
