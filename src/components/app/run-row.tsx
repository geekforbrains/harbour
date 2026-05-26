"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Terminal, Hand, Zap, Pause, Play } from "lucide-react";
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
  one_off?: number;
  agent_name?: string | null;
  job_workflow_command?: string | null;
  job_workflow_only?: number;
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
  const queryClient = useQueryClient();
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const isManual = !!run.one_off;

  async function handleToggleActive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setToggling(true);
    try {
      const res = await fetch(`/api/jobs/${run.job_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !run.job_active }),
      });
      if (!res.ok) { alert("Failed to update job"); return; }
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } finally {
      setToggling(false);
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
            {run.job_workflow_only && !run.agent_name ? (
              <><Terminal className="h-3 w-3" /><span>Workflow</span></>
            ) : (
              <>
                <span
                  className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background"
                  style={{ backgroundColor: agentColor(run.agent_name) }}
                />
                {run.job_workflow_command && run.agent_name && <Terminal className="h-3 w-3" />}
                <span className="font-mono">{run.agent_name ?? "—"}</span>
              </>
            )}
            {isManual && (
              <span
                title="Manual / one-off run"
                className="inline-flex items-center gap-1 rounded bg-muted text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium"
              >
                <Hand className="h-2.5 w-2.5" />
                Manual
              </span>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(run.completed_at || run.updated_at)}</span>
        {showActions && !isManual && (
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
      {showActions && !isManual && (
        <TriggerDialog jobId={run.job_id} jobName={run.job_name} open={triggerOpen} onOpenChange={setTriggerOpen} />
      )}
    </>
  );
}
