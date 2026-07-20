"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  /** True until a set-password link is consumed (password_hash still NULL). */
  pending: boolean;
  created_at: number;
};

/** List all users. */
export function useUsers(opts?: { enabled?: boolean }) {
  return useQuery<UserRow[]>({
    queryKey: qk.users.list(),
    queryFn: () => apiFetch<UserRow[]>("/api/users"),
    enabled: opts?.enabled ?? true,
  });
}

/** Create a user with no password yet; returns the created user row. */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; displayName: string }) =>
      apiFetch<UserRow>("/api/users", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users.all }),
  });
}

/** Delete a user. */
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users.all }),
  });
}

export type SetPasswordLink = {
  token: string;
  url: string;
  expiresAt: number;
  user: { id: string; email: string };
};

/**
 * Mint a single-use set-password / reset link for a user. The raw URL is
 * returned once — copy it and hand it over out of band.
 */
export function useSetPasswordLink() {
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<SetPasswordLink>(`/api/users/${userId}/set-password-link`, { method: "POST" }),
  });
}
