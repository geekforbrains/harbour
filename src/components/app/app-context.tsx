"use client";

import { createContext, useContext } from "react";

export type User = { userId: string; email: string; displayName: string; isInstanceAdmin: boolean };
export type Project = { id: string; name: string; created_at: number; updated_at: number };

/** Org as returned by `/api/auth/me` (orgs the user belongs to) + member role. */
export type Org = {
  id: string;
  name: string;
  settings?: string;
  member_role?: "editor" | "viewer";
  created_at: number;
  updated_at: number;
};

export type AppContextType = {
  user: User | null;
  waitingCount: number;
  timezone: string;
  /** Orgs the user can access. Instance admins additionally get an "All orgs" option. */
  orgs: Org[];
  /** Active org id, persisted in the `harbour_org` cookie. `null` = "All orgs" (instance-admin only). */
  activeOrgId: string | null;
  setActiveOrgId: (id: string | null) => void;
  projects: Project[];
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
};

export const AppContext = createContext<AppContextType>({
  user: null,
  waitingCount: 0,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  orgs: [],
  activeOrgId: null,
  setActiveOrgId: () => {},
  projects: [],
  activeProjectId: null,
  setActiveProjectId: () => {},
});

export function useApp() {
  return useContext(AppContext);
}
