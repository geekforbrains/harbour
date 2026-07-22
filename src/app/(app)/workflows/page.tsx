"use client";

import { Calendar, Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { CreateDialog } from "@/components/app/create-dialog";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ProjectBadge } from "@/components/app/project-badge";
import { RowLink } from "@/components/app/row-link";
import { formatSchedule, parseSchedule } from "@/components/app/schedule-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { timeAgo } from "@/lib/time";

type WorkflowJob = {
  id: string;
  kind: "agent" | "workflow";
  project_name: string;
  name: string;
  description: string | null;
  schedule: string;
  active: number;
  total_runs: number;
  skipped_runs: number;
  last_run_at: number | null;
  workflow_runtime: string | null;
  workflow_script: string | null;
};

export default function WorkflowsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const activeProjectId = useActiveProjectId();

  const { data: jobsData = [], isLoading: loading } = useJobs();
  // Workflows share the jobs API; agent jobs (kind === "agent") live at /jobs.
  const workflows = (jobsData as WorkflowJob[]).filter((j) => j.kind === "workflow");

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workflows"
        subtitle="Scheduled shell commands — deterministic, no agent."
        actions={
          <ActionTooltip
            hint={activeProjectId ? undefined : "Select a project to create a workflow."}
          >
            <Button onClick={() => setShowCreate(true)} size="sm" disabled={!activeProjectId}>
              <Plus className="h-4 w-4 mr-1.5" /> New Workflow
            </Button>
          </ActionTooltip>
        }
      />

      <ListState
        isEmpty={workflows.length === 0}
        emptyIcon={<Workflow className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage={
          activeProjectId
            ? "No workflows yet. Create one to get started."
            : "Select a project to create a workflow."
        }
      >
        <div className="grid gap-2">
          {workflows.map((wf) => (
            <RowLink key={wf.id} href={`/workflows/${wf.id}`}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Workflow className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{wf.name}</span>
                <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(wf.schedule))}
                  </span>
                  {wf.workflow_runtime && (
                    <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono">
                      {wf.workflow_runtime}
                    </span>
                  )}
                  {(wf.total_runs > 0 || wf.skipped_runs > 0) && (
                    <span className="hidden sm:inline">
                      {wf.total_runs} runs
                      {wf.skipped_runs > 0 ? ` · ${wf.skipped_runs} skipped` : ""}
                    </span>
                  )}
                  {wf.last_run_at && (
                    <span className="hidden sm:inline">Last run {timeAgo(wf.last_run_at)}</span>
                  )}
                </div>
              </div>
              {!activeProjectId && <ProjectBadge name={wf.project_name} />}
              {!wf.active && (
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  Paused
                </Badge>
              )}
            </RowLink>
          ))}
        </div>
      </ListState>

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} kind="workflow" />
    </div>
  );
}
