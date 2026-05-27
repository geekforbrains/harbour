"use client";

import { useState } from "react";
import Link from "next/link";
import { Terminal, Zap, Pause, Play } from "lucide-react";
import { useUpdateJob } from "@/lib/hooks/use-jobs";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/time";
import { RunStatusIcon } from "@/components/app/run-status";
import { TriggerDialog } from "@/components/app/trigger-dialog";
import { agentColor } from "@/lib/agent-color";

export type RunRowData = {
  id: string;
  status: string;
  job_id: string;
  job_name: string;
  title?: string | null;
  job_active?: number;
  agent_name?: string | null;
  job_workflow_command?: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type Props = {
  run: RunRowData;
  /** When true (default), shows the per-row Trigger / Pause buttons. Hide on per-job pages where the surrounding UI already provides them. */
  showActions?: boolean;
};

export function RunRow({ run, showActions = true }: Props) {
  const [triggerOpen, setTriggerOpen] = useState(false);
  const updateJob = useUpdateJob();
  const toggling = updateJob.isPending;
  // v2: workflow-only runs have no agent. (workflow + agent runs still have an
  // agent_name and show the agent dot plus a terminal glyph.)
  const isWorkflowOnly = !run.agent_name;

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
      <Link href={`/runs/${run.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 hover:border-foreground/20 hover:bg-accent/40 transition-colors">
        <RunStatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{run.title || run.job_name}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">{run.job_name}</div>
          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground flex-wrap">
            {isWorkflowOnly ? (
              <><Terminal className="h-3 w-3" /><span>Workflow</span></>
            ) : (
              <>
                <span
                  className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background"
                  style={{ backgroundColor: agentColor(run.agent_name) }}
                />
                {run.job_workflow_command && <Terminal className="h-3 w-3" />}
                <span className="font-mono">{run.agent_name}</span>
              </>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(run.completed_at || run.updated_at)}</span>
        {showActions && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost" size="icon" className="h-7 w-7"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTriggerOpen(true); }}
              title="Trigger run"
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7"
              onClick={handleToggleActive}
              disabled={toggling}
              title={run.job_active ? "Pause job" : "Resume job"}
            >
              {run.job_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </Link>
      {showActions && (
        <TriggerDialog jobId={run.job_id} jobName={run.job_name} open={triggerOpen} onOpenChange={setTriggerOpen} />
      )}
    </>
  );
}
