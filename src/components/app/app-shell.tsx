"use client";

import { Anchor, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api/client";
import { orgsFromMe, useMe, userFromMe } from "@/lib/hooks/use-orgs";
import { useProjects } from "@/lib/hooks/use-projects";
import { useWaitingCount } from "@/lib/hooks/use-runs";
import { AppContext, type Org, type User } from "./app-context";
import { MobileBottomNav } from "./mobile-nav";
import { NavLinks } from "./nav-links";
import { ProjectSwitcher } from "./project-switcher";
import { ThemeToggle } from "./theme-toggle";

export { useApp } from "./app-context";

const ORG_COOKIE = "harbour_org";

function readOrgCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)harbour_org=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function writeOrgCookie(id: string | null) {
  if (typeof document === "undefined") return;
  if (id) {
    // 1-year persistent cookie; server components read it for default scope.
    // biome-ignore lint/suspicious/noDocumentCookie: intentional synchronous client-side cookie write; the Cookie Store API is async and not supported in all browsers
    document.cookie = `${ORG_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
  } else {
    // biome-ignore lint/suspicious/noDocumentCookie: intentional synchronous client-side cookie clear; the Cookie Store API is async and not supported in all browsers
    document.cookie = `${ORG_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }
}

function orgTimezone(org: Org | undefined): string | null {
  if (!org?.settings) return null;
  try {
    const parsed = JSON.parse(org.settings) as { timezone?: string };
    return parsed.timezone ?? null;
  } catch {
    return null;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  // Identity + org memberships.
  const meQuery = useMe();
  const user: User | null = userFromMe(meQuery.data);
  const orgs = useMemo(() => orgsFromMe(meQuery.data), [meQuery.data]);

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

  // Active org (persisted in the harbour_org cookie). Instance admins may pick
  // "All orgs" (null); org members are pinned to their single org.
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null);
  const [orgStateLoaded, setOrgStateLoaded] = useState(false);

  useEffect(() => {
    setActiveOrgIdState(readOrgCookie());
    setOrgStateLoaded(true);
  }, []);

  function setActiveOrgId(id: string | null) {
    setActiveOrgIdState(id);
    writeOrgCookie(id);
  }

  // Reconcile the active org against memberships once both are known.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setActiveOrgId is a plain wrapper around setState + cookie write recreated each render; listing it would re-run the effect every render
  useEffect(() => {
    if (!orgStateLoaded || !user) return;
    const isAdmin = user.isInstanceAdmin;
    if (activeOrgId && !orgs.some((o) => o.id === activeOrgId)) {
      // Stored org no longer accessible.
      if (isAdmin) {
        // Admins may keep an explicit org even if not a member; otherwise clear.
        if (orgs.length === 0) return; // can't validate; leave as-is
        setActiveOrgId(null);
      } else {
        setActiveOrgId(orgs[0]?.id ?? null);
      }
    } else if (!activeOrgId && !isAdmin) {
      // Members default to their single org (no "All orgs").
      if (orgs[0]) setActiveOrgId(orgs[0].id);
    }
  }, [orgStateLoaded, user, orgs, activeOrgId]);

  // Active project (persisted in localStorage), scoped to the active org.
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [projectStateLoaded, setProjectStateLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("harbour_active_project");
    if (stored) setActiveProjectIdState(stored);
    setProjectStateLoaded(true);
  }, []);

  function setActiveProjectId(id: string | null) {
    setActiveProjectIdState(id);
    if (id) localStorage.setItem("harbour_active_project", id);
    else localStorage.removeItem("harbour_active_project");
  }

  // Projects in the active org.
  const { data: projects = [] } = useProjects(
    { orgId: activeOrgId },
    { enabled: !!user && !!activeOrgId, refetchInterval: 10000 },
  );

  // If the stored project isn't in the active org's project list, clear it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setActiveProjectId is a plain wrapper around setState + localStorage write recreated each render; listing it would re-run the effect every render
  useEffect(() => {
    if (
      projectStateLoaded &&
      activeProjectId &&
      projects.length > 0 &&
      !projects.some((p) => p.id === activeProjectId)
    ) {
      setActiveProjectId(null);
    }
  }, [projects, activeProjectId, projectStateLoaded]);

  // A project can never be active without an org. In the instance-admin "All
  // orgs" view (`activeOrgId === null`) `useProjects` is disabled, so the guard
  // above can't validate — without this mask a project id left in localStorage
  // would leak through and 403 every project-scoped request (`orgIdForProject`
  // returns null). Masking at the context boundary keeps every consumer
  // consistent (the scope prompt shows instead of a broken create form).
  const effectiveProjectId = activeOrgId ? activeProjectId : null;

  // Timezone comes from the active org's settings; falls back to the browser.
  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const timezone = orgTimezone(activeOrg) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Waiting-run count for the sidebar badge (scoped).
  const { data: waitingCount = 0 } = useWaitingCount({
    enabled: !!user && !!activeOrgId,
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
        orgs,
        activeOrgId,
        setActiveOrgId,
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
