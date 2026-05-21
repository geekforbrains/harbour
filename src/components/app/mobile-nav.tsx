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
  Radar,
  Settings,
  MoreHorizontal,
  MessageSquare,
  Inbox,
} from "lucide-react";

export function MobileBottomNav() {
  const pathname = usePathname();
  const { notificationCount } = useApp();
  const [moreOpen, setMoreOpen] = useState(false);
  const router = useRouter();

  const tabs = [
    { href: "/captain", label: "Captain", icon: MessageSquare, match: (p: string) => p.startsWith("/captain") },
    { href: "/inbox", label: "Inbox", icon: Inbox, badge: notificationCount, match: (p: string) => p.startsWith("/inbox") },
    { href: "/", label: "Runs", icon: Activity, match: (p: string) => p === "/" || p.startsWith("/runs") },
    { href: "/jobs", label: "Goals", icon: Briefcase, match: (p: string) => p.startsWith("/jobs") },
    { href: "/agents", label: "Agents", icon: Bot, match: (p: string) => p.startsWith("/agents") },
  ];

  const moreLinks = [
    { href: "/docs", label: "Docs", icon: FileText },
    { href: "/social", label: "Social", icon: Radar },
    { href: "/databases", label: "Databases", icon: Database },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  const isMoreActive = moreLinks.some((l) => pathname.startsWith(l.href));

  return (
    <>
      <div className="safe-bottom shrink-0 border-t border-[#ededed] bg-white/90 backdrop-blur md:hidden">
        <nav className="flex items-center justify-around px-2">
          {tabs.map((tab) => {
            const isActive = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-2.5 text-[11px] font-medium transition-all ${
                  isActive ? "bg-[#202020] text-white" : "text-muted-foreground"
                }`}
              >
                <tab.icon className="h-5 w-5" />
                <span>{tab.label}</span>
                {"badge" in tab && (tab.badge ?? 0) > 0 && (
                  <span className="absolute -top-0.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
                    {tab.badge}
                  </span>
                )}
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex flex-col items-center gap-0.5 rounded-xl px-3 py-2.5 text-[11px] font-medium transition-all ${
              isMoreActive ? "bg-[#202020] text-white" : "text-muted-foreground"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span>More</span>
          </button>
        </nav>
      </div>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-[28px] px-2 pb-8">
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
                    isActive ? "bg-[#202020] text-white" : "text-muted-foreground hover:bg-white"
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
