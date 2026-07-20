"use client";

import { createContext, useContext } from "react";
import type { Me } from "@/lib/hooks/use-me";

export type Project = {
  id: string;
  name: string;
  /** Workspace folder segment — assigned at creation, immutable on rename. */
  slug?: string;
  created_at: number;
  updated_at: number;
};

export type AppContextType = {
  user: Me | null;
  waitingCount: number;
  timezone: string;
  projects: Project[];
  /** Active project id, persisted in localStorage. `null` = all projects. */
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
};

export const AppContext = createContext<AppContextType>({
  user: null,
  waitingCount: 0,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  projects: [],
  activeProjectId: null,
  setActiveProjectId: () => {},
});

export function useApp() {
  return useContext(AppContext);
}
