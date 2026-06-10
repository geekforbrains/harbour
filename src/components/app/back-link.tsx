"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export function BackLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      onClick={() => router.push(href)}
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </button>
  );
}
