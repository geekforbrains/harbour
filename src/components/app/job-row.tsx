"use client";

import { Bot, Briefcase, Calendar, Folder, Workflow } from "lucide-react";
import Link from "next/link";
import { formatSchedule, parseSchedule } from "@/components/app/schedule-picker";
import { Badge } from "@/components/ui/badge";
import { resolveAgentColor } from "@/lib/agent-color";
import { statusStyle } from "@/lib/status";
import { timeAgo } from "@/lib/time";

export type JobRowData = {
  id: string;
  kind: "agent" | "workflow";
  name: string;
  project_name?: string;
  agent_name?: string | null;
  agent_color?: string | null;
  schedule: string;
  active: number;
  waiting_runs?: number;
  pending_runs?: number;
  last_run_at: number | null;
  workflow_runtime?: string | null;
};

type Props = {
  job: JobRowData;
  href: string;
  /** Hide the agent identity fact — the surrounding page already makes it obvious (an agent's own Jobs section). */
  showAgent?: boolean;
  /** Hide the project fact — the surrounding page already scopes to one project. */
  showProject?: boolean;
};

/** The row's single right-side signal, in priority order — never a badge pile. */
function jobSignal(job: JobRowData) {
  if (!job.active) return { kind: "paused" as const };
  if ((job.waiting_runs ?? 0) > 0)
    return { kind: "waiting" as const, count: job.waiting_runs ?? 0 };
  if ((job.pending_runs ?? 0) > 0)
    return { kind: "pending" as const, count: job.pending_runs ?? 0 };
  return null;
}

export function JobRow({ job, href, showAgent = true, showProject = true }: Props) {
  const signal = jobSignal(job);
  const tint =
    signal?.kind === "waiting"
      ? statusStyle("waiting")
      : signal?.kind === "pending"
        ? statusStyle("pending")
        : null;
  const Icon = job.kind === "workflow" ? Workflow : Briefcase;

  return (
    <Link
      href={href}
      className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 hover:border-foreground/20 hover:bg-accent/40 transition-colors"
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          tint ? tint.bg : "bg-muted"
        }`}
      >
        <Icon className={`h-4 w-4 ${tint ? tint.fg : "text-muted-foreground"}`} />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{job.name}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {showAgent && job.kind === "agent" && job.agent_name && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Bot
                className="h-3 w-3"
                style={{ color: resolveAgentColor(job.agent_color, job.agent_name) }}
              />
              {job.agent_name}
            </span>
          )}
          <span className="inline-flex shrink-0 items-center gap-1">
            <Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(job.schedule))}
          </span>
          {job.kind === "workflow" && job.workflow_runtime && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">
              {job.workflow_runtime}
            </span>
          )}
          {showProject && job.project_name && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Folder className="h-3 w-3" /> {job.project_name}
            </span>
          )}
        </div>
      </div>
      {signal?.kind === "paused" && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          Paused
        </Badge>
      )}
      {signal?.kind === "waiting" && (
        <Badge
          className={`shrink-0 text-[10px] ${statusStyle("waiting").bg} ${statusStyle("waiting").text}`}
        >
          {signal.count} waiting
        </Badge>
      )}
      {signal?.kind === "pending" && (
        <Badge
          className={`shrink-0 text-[10px] ${statusStyle("pending").bg} ${statusStyle("pending").text}`}
        >
          {signal.count} pending
        </Badge>
      )}
      {!signal && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {job.last_run_at ? timeAgo(job.last_run_at) : "No runs yet"}
        </span>
      )}
    </Link>
  );
}
