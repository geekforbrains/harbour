"use client";

import { Anchor, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api/client";
import { useMe, userFromMe } from "@/lib/hooks/use-me";
import { useProjects } from "@/lib/hooks/use-projects";
import { useWaitingCount } from "@/lib/hooks/use-runs";
import { useSettings } from "@/lib/hooks/use-settings";
import { AppContext } from "./app-context";
import { MobileBottomNav } from "./mobile-nav";
import { NavLinks } from "./nav-links";
import { ProjectSwitcher } from "./project-switcher";
import { ThemeToggle } from "./theme-toggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  // Identity.
  const meQuery = useMe();
  const user = userFromMe(meQuery.data);

  useEffect(() => {
    if (meQuery.isError) {
      window.location.href = "/login";
      return;
    }
    if (meQuery.data) {
      if (meQuery.data.type === "user" && meQuery.data.user) setAuthChecked(true);
      else window.location.href = "/login";
    }
  }, [meQuery.data, meQuery.isError]);

  // Active project (persisted in localStorage).
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("harbour_active_project");
    if (stored) setActiveProjectIdState(stored);
  }, []);

  function setActiveProjectId(id: string | null) {
    setActiveProjectIdState(id);
    if (id) localStorage.setItem("harbour_active_project", id);
    else localStorage.removeItem("harbour_active_project");
  }

  const { data: projects = [] } = useProjects({ enabled: !!user, refetchInterval: 10000 });

  // Mask a stored selection the loaded project list doesn't contain (deleted
  // project, or projects still loading) rather than expose a stale id; the raw
  // id stays in localStorage so a valid selection survives reloads.
  const effectiveProjectId = projects.some((p) => p.id === activeProjectId)
    ? activeProjectId
    : null;

  // Instance timezone from settings; falls back to the browser.
  const { data: settings } = useSettings({ enabled: !!user });
  const timezone = settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Waiting-run count for the sidebar badge (scoped).
  const { data: waitingCount = 0 } = useWaitingCount({
    enabled: !!user,
    refetchInterval: 5000,
  });

  async function handleLogout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
  }

  if (!authChecked) return null;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
          <Anchor className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-lg font-semibold tracking-tight">Harbour</span>
      </div>

      <Separator />

      <div className="px-2 py-2">
        <ProjectSwitcher />
      </div>
      <Separator />

      <div className="flex-1 overflow-y-auto py-2">
        <NavLinks />
      </div>

      <Separator />
      <div className="p-3 space-y-2">
        <ThemeToggle />
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground truncate">{user?.displayName}</span>
          <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8">
            <LogOut className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground/50 text-center">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </p>
      </div>
    </div>
  );

  return (
    <AppContext.Provider
      value={{
        user,
        waitingCount,
        timezone,
        projects,
        activeProjectId: effectiveProjectId,
        setActiveProjectId,
      }}
    >
      <div className="flex h-dvh standalone:h-screen">
        <aside className="hidden w-56 shrink-0 border-r bg-sidebar md:block">{sidebar}</aside>

        <div className="flex flex-1 flex-col min-w-0">
          {/* Mobile Header */}
          <div className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2 border-b bg-card/95 backdrop-blur-lg px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:hidden">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shrink-0">
              <Anchor className="h-4 w-4 text-primary-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <ProjectSwitcher variant="mobile" />
            </div>
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>

          <main className="flex-1 overflow-auto min-h-0">
            <div className="mx-auto max-w-5xl px-4 pb-6 pt-[calc(4.5rem+env(safe-area-inset-top))] md:px-8 md:pb-8 md:pt-8">
              {children}
            </div>
          </main>

          <MobileBottomNav />
        </div>
      </div>
    </AppContext.Provider>
  );
}
