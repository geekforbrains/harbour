"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

/** Instance settings KV. `timezone` is the one the app shell reads. */
export function useSettings(opts?: { enabled?: boolean }) {
  return useQuery<Record<string, string>>({
    queryKey: qk.settings.detail(),
    queryFn: () => apiFetch<Record<string, string>>("/api/settings"),
    enabled: opts?.enabled ?? true,
  });
}
