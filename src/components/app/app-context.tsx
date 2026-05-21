"use client";

import { createContext, useContext } from "react";

export type User = { userId: string; email: string; displayName: string };
export type Workspace = { id: string; name: string; slug: string; kind: string; root_path?: string | null; description?: string | null; created_at: number; updated_at: number };
export type Project = { id: string; workspace_id?: string | null; name: string; created_at: number; updated_at: number };

export type AppContextType = {
  user: User | null;
  notificationCount: number;
  timezone: string;
  workspaces: Workspace[];
  projects: Project[];
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
};

export const AppContext = createContext<AppContextType>({
  user: null,
  notificationCount: 0,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workspaces: [],
  projects: [],
  activeWorkspaceId: null,
  setActiveWorkspaceId: () => {},
  activeProjectId: null,
  setActiveProjectId: () => {},
});

export function useApp() {
  return useContext(AppContext);
}
