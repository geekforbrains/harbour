"use client";

import { Bot, Briefcase, Folder, Terminal } from "lucide-react";
import Link from "next/link";
import { RunStatusIcon } from "@/components/app/run-status";
import { resolveAgentColor } from "@/lib/agent-color";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { formatDuration, timeAgo } from "@/lib/time";

export type RunRowData = {
  id: string;
  status: string;
  project_name: string;
  job_id: string;
  job_name: string;
  job_kind?: "agent" | "workflow" | null;
  title?: string | null;
  agent_name?: string | null;
  agent_color?: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  duration_seconds: number;
};

type Props = {
  run: RunRowData;
};

export function RunRow({ run }: Props) {
  const activeProjectId = useActiveProjectId();
  const isWorkflow = run.job_kind === "workflow" || !run.agent_name;
  const title = run.title || run.job_name;
  // Only show the job name on its own line when it's telling us something the
  // title doesn't already — a run with no title yet would otherwise repeat
  // the same text twice.
  const showJobName = !!run.title && run.title !== run.job_name;

  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 hover:border-foreground/20 hover:bg-accent/40 transition-colors"
    >
      <RunStatusIcon status={run.status} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {showJobName && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Briefcase className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{run.job_name}</span>
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {isWorkflow ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Terminal className="h-3 w-3" /> Workflow
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Bot
                className="h-3 w-3 shrink-0"
                style={{ color: resolveAgentColor(run.agent_color, run.agent_name) }}
              />
              <span className="font-mono">{run.agent_name}</span>
            </span>
          )}
          {!activeProjectId && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Folder className="h-3 w-3" /> {run.project_name}
            </span>
          )}
          {run.duration_seconds > 0 && (
            <span className="shrink-0">{formatDuration(run.duration_seconds)}</span>
          )}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {timeAgo(run.completed_at || run.updated_at)}
      </span>
    </Link>
  );
}
