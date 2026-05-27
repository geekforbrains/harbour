"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import type { Org, User } from "@/components/app/app-context";

type MeResponse =
  | { type: "user"; user: { id: string; email: string; display_name: string; is_instance_admin?: number }; orgs: Org[] }
  | { type: "agent"; agent: unknown };

/**
 * Identity + org memberships from `/api/auth/me`. This is the bootstrap query
 * the app shell uses to learn who the user is and which orgs they can scope to.
 */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/api/auth/me"),
    staleTime: 30_000,
    retry: false,
  });
}

/** Normalize a `/api/auth/me` response into the app-context user shape. */
export function userFromMe(me: MeResponse | undefined): User | null {
  if (!me || me.type !== "user" || !me.user) return null;
  return {
    userId: me.user.id,
    email: me.user.email,
    displayName: me.user.display_name,
    isInstanceAdmin: !!me.user.is_instance_admin,
  };
}

export function orgsFromMe(me: MeResponse | undefined): Org[] {
  if (!me || me.type !== "user") return [];
  return me.orgs ?? [];
}

/**
 * Update an org's name and/or settings (e.g. timezone). Settings are merged
 * server-side. Invalidates `me`, the source of the org list (and the active
 * org's settings the app shell reads its timezone from).
 */
export function useUpdateOrg(orgId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; settings?: Record<string, unknown> }) =>
      apiFetch<Org>(scoped("/api/orgs", { orgId }), { method: "PUT", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: qk.orgs.all });
    },
  });
}
