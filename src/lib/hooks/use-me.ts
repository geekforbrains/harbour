"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";

type MeResponse = {
  type: "user";
  user: { id: string; email: string; display_name: string };
};

/** The signed-in user, camelCased for the app-context shape. */
export type Me = { userId: string; email: string; displayName: string };

/**
 * Identity from `/api/auth/me`. This is the bootstrap query the app shell uses
 * to learn who the user is.
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
export function userFromMe(me: MeResponse | undefined): Me | null {
  if (me?.type !== "user" || !me.user) return null;
  return {
    userId: me.user.id,
    email: me.user.email,
    displayName: me.user.display_name,
  };
}
