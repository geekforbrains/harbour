"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, Activity, Zap } from "lucide-react";

type Metrics = {
  runs: { running: number; pending: number };
  system: { cpuPct: number; memPct: number };
  freellm: { enabled: boolean; online: boolean; modelCount: number };
};

export function TokenStatusBar() {
  const [tick, setTick] = useState(0);

  // Refresh every 15 seconds
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const { data: metrics } = useQuery<Metrics>({
    queryKey: ["metrics-bar", tick],
    queryFn: async () => {
      const res = await fetch("/api/metrics");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 0,
    // Don't throw on error — silently hide bar if metrics fail
  });

  // Only show if there's something worth showing
  const hasActiveRuns = (metrics?.runs.running ?? 0) > 0;
  const freellmEnabled = metrics?.freellm.enabled ?? false;
  const show = hasActiveRuns || freellmEnabled || metrics !== undefined;

  if (!show || !metrics) return null;

  const cpuWarn = metrics.system.cpuPct > 80;
  const memWarn = metrics.system.memPct > 85;

  return (
    <div className="hidden shrink-0 items-center gap-4 border-t border-[#ededed] bg-white/55 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur md:flex">
      {/* FreeLLM status */}
      {freellmEnabled && (
        <span className="flex items-center gap-1.5">
          <Zap className="h-3 w-3" />
          <span className={metrics.freellm.online ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}>
            FreeLLM {metrics.freellm.online ? `on · ${metrics.freellm.modelCount} models` : "offline"}
          </span>
        </span>
      )}

      {/* Active runs */}
      {hasActiveRuns && (
        <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <Activity className="h-3 w-3 animate-pulse" />
          {metrics.runs.running} running{metrics.runs.pending > 0 ? ` · ${metrics.runs.pending} queued` : ""}
        </span>
      )}

      <span className="flex-1" />

      {/* CPU */}
      <span className={`flex items-center gap-1 tabular-nums ${cpuWarn ? "text-red-500" : ""}`}>
        <Cpu className="h-3 w-3" />
        CPU {metrics.system.cpuPct}%
      </span>

      {/* RAM */}
      <span className={`tabular-nums ${memWarn ? "text-red-500" : ""}`}>
        RAM {metrics.system.memPct}%
      </span>
    </div>
  );
}
