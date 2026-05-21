"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./app-context";
import { cn } from "@/lib/utils";
import {
  Inbox,
  LayoutList,
  MessageSquare,
  Rabbit,
  ExternalLink,
} from "lucide-react";

// ─── Primitives ──────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="mt-4 mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-[#a0a0a0] select-none">
      {label}
    </p>
  );
}

interface NavItemProps {
  href: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: number;
  size?: "default" | "small";
  active?: boolean;
  onClick?: () => void;
}

function NavItem({ href, label, icon: Icon, badge, size = "default", active, onClick }: NavItemProps) {
  const isSmall = size === "small";
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-xl transition-all duration-200",
        isSmall ? "px-2 py-1 text-xs" : "px-2 py-1.5 text-sm",
        active
          ? "bg-[#202020] text-white font-medium shadow-[2px_6px_16px_rgba(0,0,0,0.08)]"
          : "text-[#7c7c7c] hover:bg-white hover:text-[#202020]"
      )}
    >
      {Icon && <Icon className={cn("shrink-0", isSmall ? "h-3.5 w-3.5" : "h-4 w-4")} />}
      <span className="truncate flex-1">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium leading-none text-primary-foreground">
          {badge}
        </span>
      )}
    </Link>
  );
}


function ExternalNavItem({ href, label, icon: Icon, size = "default" }: Omit<NavItemProps, "active" | "onClick" | "badge"> & { href: string }) {
  const isSmall = size === "small";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-2.5 rounded-xl transition-all duration-200",
        isSmall ? "px-2 py-1 text-xs" : "px-2 py-1.5 text-sm",
        "text-[#7c7c7c] hover:bg-white hover:text-[#202020]"
      )}
    >
      {Icon && <Icon className={cn("shrink-0", isSmall ? "h-3.5 w-3.5" : "h-4 w-4")} />}
      <span className="truncate flex-1">{label}</span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-40" />
    </a>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function WorkspaceNav({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  const { notificationCount } = useApp();

  return (
    <nav className="flex flex-col gap-0 px-2">

      {/* ── Captain ────────────────────────────────────────────────────────── */}
      <NavItem
        href="/captain"
        label="Captain"
        icon={MessageSquare}
        active={pathname.startsWith("/captain")}
        onClick={onClick}
      />

      {/* ── Quick access ───────────────────────────────────────────────────── */}
      <NavItem
        href="/inbox"
        label="Inbox"
        icon={Inbox}
        badge={notificationCount}
        active={pathname.startsWith("/inbox")}
        onClick={onClick}
      />
      <NavItem
        href="/"
        label="All Runs"
        icon={LayoutList}
        active={pathname === "/" || pathname.startsWith("/runs")}
        onClick={onClick}
      />


      {/* ── Tools ──────────────────────────────────────────────────────────── */}
      <SectionHeader label="Tools" />
      <ExternalNavItem
        href="http://localhost:2026"
        label="DeerFlow"
        icon={Rabbit}
      />

    </nav>
  );
}
