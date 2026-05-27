"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
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
