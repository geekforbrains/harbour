"use client";

import { Bot, Pause, Play, Terminal, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ProjectBadge } from "@/components/app/project-badge";
import { RunStatusIcon } from "@/components/app/run-status";
import { TriggerDialog } from "@/components/app/trigger-dialog";
import { Button } from "@/components/ui/button";
import { resolveAgentColor } from "@/lib/agent-color";
import { useUpdateJob } from "@/lib/hooks/use-jobs";
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
  job_active?: number;
  agent_name?: string | null;
  agent_color?: string | null;
  job_prerun_script?: string | null;
  job_workflow_script?: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  duration_seconds: number;
};

type Props = {
  run: RunRowData;
  /** When true (default), shows the per-row Trigger / Pause buttons. Hide on per-job pages where the surrounding UI already provides them. */
  showActions?: boolean;
};

export function RunRow({ run, showActions = true }: Props) {
  const [triggerOpen, setTriggerOpen] = useState(false);
  const activeProjectId = useActiveProjectId();
  const updateJob = useUpdateJob();
  const toggling = updateJob.isPending;
  const isWorkflow = run.job_kind === "workflow" || !run.agent_name;

  async function handleToggleActive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await updateJob.mutateAsync({ id: run.job_id, body: { active: !run.job_active } });
    } catch {
      alert("Failed to update job");
    }
  }

  return (
    <>
      <Link
        href={`/runs/${run.id}`}
        className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 hover:border-foreground/20 hover:bg-accent/40 transition-colors"
      >
        <RunStatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{run.title || run.job_name}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">{run.job_name}</div>
          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground flex-wrap">
            {isWorkflow ? (
              <>
                <Terminal className="h-3 w-3" />
                <span>Workflow</span>
              </>
            ) : (
              <>
                <Bot
                  className="h-3 w-3 shrink-0"
                  style={{ color: resolveAgentColor(run.agent_color, run.agent_name) }}
                />
                <span className="font-mono">{run.agent_name}</span>
              </>
            )}
            {!activeProjectId && <ProjectBadge name={run.project_name} className="h-4 px-1.5" />}
            {run.duration_seconds > 0 && <span>{`· ${formatDuration(run.duration_seconds)}`}</span>}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {timeAgo(run.completed_at || run.updated_at)}
        </span>
        {showActions && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTriggerOpen(true);
              }}
              title="Trigger run"
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleToggleActive}
              disabled={toggling}
              title={run.job_active ? "Pause job" : "Resume job"}
            >
              {run.job_active ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}
      </Link>
      {showActions && (
        <TriggerDialog
          jobId={run.job_id}
          jobName={run.job_name}
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          workflow={isWorkflow}
        />
      )}
    </>
  );
}
