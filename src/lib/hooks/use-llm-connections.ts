"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type Scope, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

export type LlmConnectionKind =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "openai-compatible";
export type LlmProtocol = "native" | "chat-completions" | "responses";
export type LlmConnectionInput = {
  name: string;
  kind: LlmConnectionKind;
  provider_id: string;
  base_url?: string | null;
  protocol: LlmProtocol;
  credential_id?: string | null;
  credential?: { name: string; value: string };
};

export type LlmConnection = {
  id: string;
  project_id: string;
  project_name?: string;
  name: string;
  kind: LlmConnectionKind;
  provider_id: string;
  base_url: string | null;
  protocol: LlmProtocol;
  credential: { id: string; name: string } | null;
  agent_count?: number;
  created_at?: number;
  updated_at?: number;
};

export async function invalidateLlmConnectionCaches(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  options: {
    connectionId?: string;
    refreshAgents?: boolean;
    input?: Partial<LlmConnectionInput>;
  } = {},
): Promise<void> {
  const invalidations = [queryClient.invalidateQueries({ queryKey: qk.llmConnections.all })];
  if (options.connectionId) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: qk.llmConnections.detail(options.connectionId),
      }),
    );
  }
  if (options.refreshAgents) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: qk.agents.all }));
  }
  if (options.input?.credential !== undefined) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: qk.envVars.all }));
  }
  await Promise.all(invalidations);
}

/** List connections in the active project, or across projects in the all-projects view. */
export function useLlmConnections(scope?: Scope, opts?: { enabled?: boolean }) {
  const active = useScope();
  const selectedScope = scope ?? active;
  return useQuery<LlmConnection[]>({
    queryKey: qk.llmConnections.list(selectedScope),
    queryFn: () => apiFetch<LlmConnection[]>(scoped("/api/llm-connections", selectedScope)),
    enabled: opts?.enabled ?? true,
  });
}

export function useLlmConnection(id: string, opts?: { enabled?: boolean }) {
  return useQuery<LlmConnection>({
    queryKey: qk.llmConnections.detail(id),
    queryFn: () => apiFetch<LlmConnection>(`/api/llm-connections/${id}`),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

export function useCreateLlmConnection() {
  const queryClient = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (body: LlmConnectionInput) =>
      apiFetch<LlmConnection>(scoped("/api/llm-connections", scope), {
        method: "POST",
        body,
      }),
    onSuccess: (_connection, input) => invalidateLlmConnectionCaches(queryClient, { input }),
  });
}

export function useLlmConnectionMutations(id: string) {
  const queryClient = useQueryClient();
  return {
    update: useMutation({
      mutationFn: (body: Partial<LlmConnectionInput>) =>
        apiFetch<LlmConnection>(`/api/llm-connections/${id}`, { method: "PUT", body }),
      onSuccess: (_connection, input) =>
        invalidateLlmConnectionCaches(queryClient, {
          connectionId: id,
          refreshAgents: true,
          input,
        }),
    }),
    remove: useMutation({
      mutationFn: () => apiFetch(`/api/llm-connections/${id}`, { method: "DELETE" }),
      onSuccess: () =>
        invalidateLlmConnectionCaches(queryClient, {
          connectionId: id,
          refreshAgents: true,
        }),
    }),
  };
}

export function useUpdateLlmConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<LlmConnectionInput> }) =>
      apiFetch<LlmConnection>(`/api/llm-connections/${id}`, { method: "PUT", body }),
    onSuccess: (_connection, variables) =>
      invalidateLlmConnectionCaches(queryClient, {
        connectionId: variables.id,
        refreshAgents: true,
        input: variables.body,
      }),
  });
}

export function useDeleteLlmConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/llm-connections/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateLlmConnectionCaches(queryClient, { refreshAgents: true }),
  });
}
