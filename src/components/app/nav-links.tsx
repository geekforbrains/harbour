"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Briefcase,
  Bot,
  FileText,
  Database,
  Radar,
  Sparkles,
  Settings,
} from "lucide-react";

export function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  const links = [
    { href: "/jobs", label: "Goals", icon: Briefcase },
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/social", label: "Social", icon: Radar },
    { href: "/docs", label: "Docs", icon: FileText },
    { href: "/databases", label: "Databases", icon: Database },
    { href: "/skills", label: "Libraries", icon: Sparkles },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="flex flex-col gap-1 px-2">
      {links.map((link) => {
        const isActive = link.href === "/"
          ? pathname === "/" || pathname.startsWith("/runs")
          : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onClick}
            className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ${
              isActive
                ? "bg-[#202020] text-white shadow-[2px_6px_16px_rgba(0,0,0,0.08)]"
                : "text-[#7c7c7c] hover:bg-white hover:text-[#202020]"
            }`}
          >
            <link.icon className="h-4 w-4" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
