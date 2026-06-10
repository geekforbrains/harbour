"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

export type UserMembership = {
  org_id: string;
  org_name: string;
  role: "editor" | "viewer";
};

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  is_instance_admin: number;
  /** True until a set-password link is consumed (password_hash still NULL). */
  pending: boolean;
  created_at: number;
  memberships: UserMembership[];
};

/** Instance-admin-only: list all users (with their org memberships). */
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
    mutationFn: (body: { email: string; displayName: string; isInstanceAdmin?: boolean }) =>
      apiFetch<UserRow>("/api/users", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users.all }),
  });
}

/** Update a user (toggle instance_admin, rename). */
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      displayName?: string;
      isInstanceAdmin?: boolean;
    }) => apiFetch<UserRow>(`/api/users/${id}`, { method: "PUT", body }),
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

/** Add (or change the role of) a user's membership in an org. */
export function useAddMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orgId,
      userId,
      role,
    }: {
      orgId: string;
      userId: string;
      role: "editor" | "viewer";
    }) => apiFetch(`/api/orgs/${orgId}/members`, { method: "POST", body: { userId, role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users.all }),
  });
}

/** Remove a user's membership from an org. */
export function useRemoveMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orgId, userId }: { orgId: string; userId: string }) =>
      apiFetch(`/api/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users.all }),
  });
}
