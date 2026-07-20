"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

/** A row from the instance-level runner registry (no token — that's mint-only). */
export type Runner = {
  id: string;
  name: string;
  tier: "local" | "remote";
  labels: string[];
  capabilities: { kinds: string[]; clis: string[]; labels: string[] } | null;
  scope: { agentId?: string } | null;
  last_polled_at: number | null;
  /** In-flight runs this runner is currently executing (the execution-pool view). */
  running_count?: number;
  created_at: number;
  updated_at: number;
};

/** What a successful mint returns — the plaintext token + a ready connect command. */
export type MintedRunner = Runner & { token: string; connect: string };

/** The runner registry is instance-level, so these are not project-scoped. */
export function useRunners(opts?: { enabled?: boolean }) {
  return useQuery<Runner[]>({
    queryKey: qk.runners.list(),
    queryFn: () => apiFetch<Runner[]>("/api/runners"),
    enabled: opts?.enabled ?? true,
  });
}

export function useCreateRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; labels?: string[]; scope?: { agentId?: string } }) =>
      apiFetch<MintedRunner>("/api/runners", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runners.all }),
  });
}

export function useDeleteRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/runners/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runners.all }),
  });
}
