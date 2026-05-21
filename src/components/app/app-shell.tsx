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

  const { data: notificationCount = 0 } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const res = await fetch("/api/notifications?filter=unread-count");
      if (!res.ok) return 0;
      const data = await res.json();
      return typeof data.count === "number" ? data.count : 0;
    },
    refetchInterval: 10000,
    enabled: !!user,
  });

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  if (!authChecked) return null;

  // Pages that need edge-to-edge layout (no max-w-5xl centering)
  const isFullBleed = pathname.startsWith("/captain");
  const isWidePage = pathname.startsWith("/social");

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="borg-brand-mark">B</span>
        <span className="font-heading text-lg font-normal tracking-normal text-[#202020]">BORG Interface</span>
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
          <span className="truncate text-sm font-medium text-muted-foreground">
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
    <AppContext.Provider value={{ user, notificationCount, timezone, workspaces, projects, activeWorkspaceId, setActiveWorkspaceId, activeProjectId, setActiveProjectId }}>
      <div className="borg-app-root h-dvh standalone:h-screen md:p-4 lg:p-6">
        <div className="relative z-10 flex h-full w-full min-w-0">
          <aside className="borg-sidebar hidden w-[220px] shrink-0 overflow-hidden border md:block md:rounded-[32px]">
            {sidebar}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col md:pl-4 lg:pl-6">
            {/* Mobile Header */}
            <div className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2 border-b border-[#ededed] bg-white/90 px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur-lg md:hidden">
              <span className="borg-brand-mark h-8 w-8 shrink-0">B</span>
              <div className="flex-1 min-w-0">
                <ProjectSwitcher variant="mobile" />
              </div>
              <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>

            <main className="borg-main-stage flex-1 min-h-0 overflow-hidden border-0 md:rounded-[42px] md:border-2 md:p-1">
              <div className="borg-main-surface h-full overflow-auto md:rounded-[40px]">
                {isFullBleed ? (
                  children
                ) : (
                  <div className={`borg-page-frame mx-auto px-4 pb-24 pt-[calc(4.5rem+env(safe-area-inset-top))] md:px-8 md:pb-8 md:pt-8 lg:px-10 lg:pt-10 ${isWidePage ? "max-w-[1280px]" : "max-w-5xl"}`}>
                    {children}
                  </div>
                )}
              </div>
            </main>

            <TokenStatusBar />
            <MobileBottomNav />
          </div>
        </div>
      </div>
    </AppContext.Provider>
  );
}
