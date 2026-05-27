"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped, type Scope } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type Doc = { id: string; title: string; pinned: number; [key: string]: unknown };

/** List docs in scope (org-level + project-level when a project is active). */
export function useDocs(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const s = scope ?? active;
  return useQuery<Doc[]>({
    queryKey: qk.docs.list(s),
    queryFn: () => apiFetch<Doc[]>(scoped("/api/docs", s)),
    enabled: (opts?.enabled ?? true) && !!s.orgId,
  });
}

export function useDoc(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.docs.detail(id),
    queryFn: () => apiFetch(`/api/docs/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useDocRevisions(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.docs.revisions(id),
    queryFn: () => apiFetch(`/api/docs/${id}/revisions`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useCreateDoc() {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<Doc>(scoped("/api/docs", scope), { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.docs.all }),
  });
}

export function useDocMutations(id: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.docs.all });
    qc.invalidateQueries({ queryKey: qk.docs.detail(id) });
  };
  return {
    update: useMutation({
      mutationFn: (body: Record<string, unknown>) =>
        apiFetch(`/api/docs/${id}`, { method: "PUT", body }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: () => apiFetch(`/api/docs/${id}`, { method: "DELETE" }),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.docs.all }),
    }),
    togglePin: useMutation({
      mutationFn: () => apiFetch(`/api/docs/${id}/pin`, { method: "POST" }),
      onSuccess: invalidate,
    }),
  };
}
