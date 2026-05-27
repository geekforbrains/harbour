"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  is_instance_admin: number;
  created_at: number;
};

/** Instance-admin-only: list all users. */
export function useUsers(opts?: { enabled?: boolean }) {
  return useQuery<UserRow[]>({
    queryKey: qk.users.list(),
    queryFn: () => apiFetch<UserRow[]>("/api/users"),
    enabled: opts?.enabled ?? true,
  });
}
