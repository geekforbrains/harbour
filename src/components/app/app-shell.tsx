"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LogOut } from "lucide-react";

import { AppContext, type User, type Project, type Workspace } from "./app-context";
import { ThemeToggle } from "./theme-toggle";
import { WorkspaceNav } from "./workspace-nav";
import { NavLinks } from "./nav-links";
import { ProjectSwitcher, WorkspaceProjectList } from "./project-switcher";
import { MobileBottomNav } from "./mobile-nav";
import { TokenStatusBar } from "./token-status-bar";

export { useApp } from "./app-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/auth/me").then((r) => {
      if (r.ok) return r.json();
      throw new Error("Not authed");
    }).then((data) => {
      if (data.type === "user" && data.user) {
        setUser({ userId: data.user.id, email: data.user.email, displayName: data.user.display_name });
        setAuthChecked(true);
      } else {
        throw new Error("Not authed");
      }
    }).catch(() => { window.location.href = "/login"; });
  }, [router]);

  // Active workspace/project (persisted in localStorage)
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("harbour_active_workspace");
  });
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("harbour_active_project");
  });

  function setActiveWorkspaceId(id: string | null) {
    setActiveWorkspaceIdState(id);
    setActiveProjectId(null);
    if (typeof window === "undefined") return;
    if (id) localStorage.setItem("harbour_active_workspace", id);
    else localStorage.removeItem("harbour_active_workspace");
  }

  function setActiveProjectId(id: string | null) {
    setActiveProjectIdState(id);
    if (typeof window === "undefined") return;
    if (id) localStorage.setItem("harbour_active_project", id);
    else localStorage.removeItem("harbour_active_project");
  }

  // Fetch workspaces
  const { data: workspaces = [] } = useQuery<Workspace[]>({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await fetch("/api/workspaces");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 10000,
    enabled: !!user,
  });

  // Fetch projects
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 10000,
    enabled: !!user,
  });

  // Fetch system timezone
  const { data: timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = useQuery({
    queryKey: ["settings", "timezone"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data = await res.json();
      return data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
    enabled: !!user,
  });

  // Poll waiting runs count (project/workspace filtered)
  const waitingScopeParam = activeProjectId
    ? `&projectId=${activeProjectId}`
    : activeWorkspaceId ? `&workspaceId=${activeWorkspaceId}` : "";
  const { data: waitingCount = 0 } = useQuery({
    queryKey: ["runs", "waiting-count", activeProjectId, activeWorkspaceId],
    queryFn: async () => {
      const res = await fetch(`/api/runs?filter=waiting${waitingScopeParam}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return Array.isArray(data) ? data.length : 0;
    },
    refetchInterval: 5000,
    enabled: !!user,
  });

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  if (!authChecked) return null;

  // Pages that need edge-to-edge layout (no max-w-5xl centering)
  const isFullBleed = pathname.startsWith("/captain");

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
          <span className="text-base leading-none">👽</span>
        </div>
        <span className="text-lg font-semibold tracking-tight">BORG Interface</span>
      </div>

      <Separator />

      <div className="px-2 py-2">
        <ProjectSwitcher />
      </div>
      <WorkspaceProjectList />

      <Separator />

      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        <WorkspaceNav />
        <Separator className="my-2" />
        <NavLinks />
      </div>

      <Separator />
      <div className="p-3 space-y-2">
        <ThemeToggle />
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground truncate">
            {user?.displayName}
          </span>
          <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8">
            <LogOut className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground/50 text-center">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
      </div>
    </div>
  );

  return (
    <AppContext.Provider value={{ user, waitingCount, timezone, workspaces, projects, activeWorkspaceId, setActiveWorkspaceId, activeProjectId, setActiveProjectId }}>
      <div className="flex h-dvh standalone:h-screen">
        <aside className="hidden w-56 shrink-0 border-r bg-sidebar md:block">
          {sidebar}
        </aside>

        <div className="flex flex-1 flex-col min-w-0">
          {/* Mobile Header */}
          <div className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2 border-b bg-card/95 backdrop-blur-lg px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:hidden">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shrink-0">
              <span className="text-base leading-none">👽</span>
            </div>
            <div className="flex-1 min-w-0">
              <ProjectSwitcher variant="mobile" />
            </div>
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>

          <main className="flex-1 overflow-auto min-h-0">
            {isFullBleed ? (
              children
            ) : (
              <div className="mx-auto max-w-5xl px-4 pb-6 pt-[calc(4.5rem+env(safe-area-inset-top))] md:px-8 md:pb-8 md:pt-8">
                {children}
              </div>
            )}
          </main>

          <TokenStatusBar />
          <MobileBottomNav />
        </div>
      </div>
    </AppContext.Provider>
  );
}
