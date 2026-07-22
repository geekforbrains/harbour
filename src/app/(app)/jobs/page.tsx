"use client";

import { Bot, Briefcase, Calendar, Plus } from "lucide-react";
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
import { resolveAgentColor } from "@/lib/agent-color";
import { useAgents } from "@/lib/hooks/use-agents";
import { useJobs } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { statusStyle } from "@/lib/status";
import { timeAgo } from "@/lib/time";

type Job = {
  id: string;
  kind: "agent" | "workflow";
  project_name: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_color: string | null;
  name: string;
  description: string | null;
  schedule: string;
  active: number;
  total_runs: number;
  skipped_runs: number;
  waiting_runs: number;
  pending_runs: number;
  last_run_at: number | null;
  prerun_script: string | null;
};

export default function JobsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const activeProjectId = useActiveProjectId();

  const { data: jobsData = [], isLoading: loading } = useJobs();
  // An agent job attaches to an agent in the active project, so creating one
  // needs both a project and at least one agent there.
  const { data: agents = [], isLoading: agentsLoading } = useAgents();
  // Workflows (kind === "workflow") have their own page at /workflows.
  const jobs = (jobsData as Job[]).filter((j) => j.kind !== "workflow");

  const newJobHint = !activeProjectId
    ? "Select a project to create a job."
    : !agentsLoading && agents.length === 0
      ? "Create an agent in this project first."
      : undefined;

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        subtitle="Recurring work across all agents."
        actions={
          <div className="flex gap-2">
            {/* TODO(v2): "Add Existing" removed — see tables/page.tsx. No
                project_id reparent route exists; new jobs land in the active project. */}
            <ActionTooltip hint={newJobHint}>
              <Button onClick={() => setShowCreate(true)} size="sm" disabled={!!newJobHint}>
                <Plus className="h-4 w-4 mr-1.5" /> New Job
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      <ListState
        isEmpty={jobs.length === 0}
        emptyIcon={<Briefcase className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage={newJobHint ?? "No jobs yet. Create one to get started."}
      >
        <div className="grid gap-2">
          {jobs.map((job) => {
            const agentTint = resolveAgentColor(job.agent_color, job.agent_name);
            const boxTint = job.active ? agentTint : null;
            return (
              <RowLink key={job.id} href={`/jobs/${job.id}`}>
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    boxTint
                      ? ""
                      : !job.active
                        ? "bg-muted"
                        : job.waiting_runs > 0
                          ? statusStyle("waiting").bg
                          : job.pending_runs > 0
                            ? statusStyle("pending").bg
                            : "bg-muted"
                  }`}
                  style={boxTint ? { backgroundColor: `${boxTint}1f`, color: boxTint } : undefined}
                >
                  <Briefcase
                    className={`h-4 w-4 ${
                      boxTint
                        ? ""
                        : !job.active
                          ? "text-muted-foreground"
                          : job.waiting_runs > 0
                            ? statusStyle("waiting").fg
                            : job.pending_runs > 0
                              ? statusStyle("pending").fg
                              : "text-muted-foreground"
                    }`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{job.name}</span>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 mt-1 text-xs text-muted-foreground">
                    {job.agent_name && (
                      <span className="flex items-center gap-1">
                        <Bot className="h-3 w-3" style={{ color: agentTint ?? undefined }} />{" "}
                        {job.agent_name}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(job.schedule))}
                    </span>
                    {job.prerun_script && (
                      <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">prerun</span>
                    )}
                    {(job.total_runs > 0 || job.skipped_runs > 0) && (
                      <span className="hidden sm:inline">
                        {job.total_runs} runs
                        {job.skipped_runs > 0 ? ` · ${job.skipped_runs} skipped` : ""}
                      </span>
                    )}
                    {job.last_run_at && (
                      <span className="hidden sm:inline">Last run {timeAgo(job.last_run_at)}</span>
                    )}
                  </div>
                </div>
                {!activeProjectId && <ProjectBadge name={job.project_name} />}
                {(!job.active || job.waiting_runs > 0 || job.pending_runs > 0) && (
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!job.active && (
                      <Badge variant="secondary" className="text-[10px]">
                        Paused
                      </Badge>
                    )}
                    {job.waiting_runs > 0 && (
                      <Badge
                        className={`text-[10px] ${statusStyle("waiting").bg} ${statusStyle("waiting").text} hover:bg-amber-500/10`}
                      >
                        {job.waiting_runs} waiting
                      </Badge>
                    )}
                    {job.pending_runs > 0 && (
                      <Badge
                        className={`text-[10px] ${statusStyle("pending").bg} ${statusStyle("pending").text} hover:bg-violet-500/10`}
                      >
                        {job.pending_runs} pending
                      </Badge>
                    )}
                  </div>
                )}
              </RowLink>
            );
          })}
        </div>
      </ListState>

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} kind="agent" />
    </div>
  );
}
