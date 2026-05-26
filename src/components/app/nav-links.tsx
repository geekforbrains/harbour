"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./app-context";
import {
  Activity,
  Briefcase,
  Bot,
  FileText,
  Database,
  KeyRound,
  Users,
  Settings,
  MessageSquare,
} from "lucide-react";

export function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  const { waitingCount } = useApp();

  const links = [
    { href: "/captain", label: "Captain", icon: MessageSquare },
    { href: "/", label: "Runs", icon: Activity, badge: waitingCount },
    { href: "/jobs", label: "Jobs", icon: Briefcase },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/docs", label: "Docs", icon: FileText },
    { href: "/databases", label: "Databases", icon: Database },
    { href: "/env-vars", label: "Env Vars", icon: KeyRound },
    { href: "/users", label: "Users", icon: Users },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {links.map((link) => {
        const isActive = link.href === "/"
          ? pathname === "/" || pathname.startsWith("/runs")
          : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onClick}
            className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-primary text-primary-foreground font-semibold"
                : "text-muted-foreground font-medium hover:bg-accent hover:text-foreground"
            }`}
          >
            <link.icon className={`h-4 w-4 shrink-0 ${isActive ? "" : "text-muted-foreground group-hover:text-foreground"}`} />
            {link.label}
            {"badge" in link && (link.badge ?? 0) > 0 && (
              <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-none text-white">
                {link.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
