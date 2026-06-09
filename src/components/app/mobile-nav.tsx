"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useApp } from "./app-context";
import { ThemeToggle } from "./theme-toggle";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Activity,
  Briefcase,
  Bot,
  FileText,
  Database,
  KeyRound,
  Users,
  Settings,
  MoreHorizontal,
  MessageSquare,
} from "lucide-react";

export function MobileBottomNav() {
  const pathname = usePathname();
  const { waitingCount } = useApp();
  const [moreOpen, setMoreOpen] = useState(false);
  const router = useRouter();

  const tabs = [
    { href: "/captain", label: "Captain", icon: MessageSquare, match: (p: string) => p.startsWith("/captain") },
    { href: "/", label: "Runs", icon: Activity, badge: waitingCount, match: (p: string) => p === "/" || p.startsWith("/runs") },
    { href: "/jobs", label: "Jobs", icon: Briefcase, match: (p: string) => p.startsWith("/jobs") },
    { href: "/agents", label: "Agents", icon: Bot, match: (p: string) => p.startsWith("/agents") },
  ];

  const moreLinks = [
    { href: "/docs", label: "Docs", icon: FileText },
    { href: "/databases", label: "Databases", icon: Database },
    { href: "/env-vars", label: "Secrets", icon: KeyRound },
    { href: "/users", label: "Users", icon: Users },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  const isMoreActive = moreLinks.some((l) => pathname.startsWith(l.href));

  return (
    <>
      <div className="shrink-0 border-t bg-card safe-bottom md:hidden">
        <nav className="flex items-center justify-around px-2">
          {tabs.map((tab) => {
            const isActive = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`relative flex flex-col items-center gap-0.5 px-3 py-2.5 text-[11px] font-medium transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <tab.icon className="h-5 w-5" />
                <span>{tab.label}</span>
                {"badge" in tab && (tab.badge ?? 0) > 0 && (
                  <span className="absolute -top-0.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
                    {tab.badge}
                  </span>
                )}
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex flex-col items-center gap-0.5 px-3 py-2.5 text-[11px] font-medium transition-colors ${
              isMoreActive ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span>More</span>
          </button>
        </nav>
      </div>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl px-2 pb-8">
          <nav className="grid grid-cols-3 gap-1 pt-2">
            {moreLinks.map((link) => {
              const isActive = pathname.startsWith(link.href);
              return (
                <button
                  key={link.href}
                  onClick={() => {
                    setMoreOpen(false);
                    router.push(link.href);
                  }}
                  className={`flex flex-col items-center gap-1.5 rounded-xl px-3 py-4 text-sm font-medium transition-colors ${
                    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <link.icon className="h-5 w-5" />
                  <span className="text-xs">{link.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="flex items-center justify-between px-2 pt-3 mt-2 border-t">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
          <p className="text-[11px] text-muted-foreground/50 text-center pt-2">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>
        </SheetContent>
      </Sheet>
    </>
  );
}
