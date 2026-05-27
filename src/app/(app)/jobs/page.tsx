"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Briefcase, Bot, Calendar } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { ScopePrompt } from "@/components/app/scope-prompt";
import { statusStyle } from "@/lib/status";
import { CreateDialog } from "@/components/app/create-dialog";
import { formatSchedule, parseSchedule } from "@/components/app/schedule-picker";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useJobs } from "@/lib/hooks/use-jobs";

type Job = {
  id: string; agent_id: string | null; agent_name: string | null; name: string;
  description: string | null; schedule: string;
  active: number; total_runs: number; skipped_runs: number; waiting_runs: number; pending_runs: number;
  last_run_at: number | null; workflow_command: string | null;
};

// v2 dropped the jobs.workflow_only column — a job is workflow-only iff it has
// no agent. (workflow + agent = workflow_command set AND agent_id present.)
const isWorkflowOnly = (j: Job) => !j.agent_id;

export default function JobsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const activeProjectId = useActiveProjectId();

  const { data: jobsData = [], isLoading: loading } = useJobs();
  const jobs = jobsData as Job[];

  function renderJobSection(title: string, sectionJobs: Job[]) {
    if (sectionJobs.length === 0) return null;
    return (
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <div className="grid gap-2">
          {sectionJobs.map(job => (
            <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                !job.active ? "bg-muted" : job.waiting_runs > 0 ? statusStyle("waiting").bg : job.pending_runs > 0 ? statusStyle("pending").bg : "bg-muted"
              }`}>
                <Briefcase className={`h-4 w-4 ${
                  !job.active ? "text-muted-foreground" : job.waiting_runs > 0 ? statusStyle("waiting").fg : job.pending_runs > 0 ? statusStyle("pending").fg : "text-muted-foreground"
                }`} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{job.name}</span>
                <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 mt-1 text-xs text-muted-foreground">
                  {job.agent_name && (
                    <span className="flex items-center gap-1"><Bot className="h-3 w-3" /> {job.agent_name}</span>
                  )}
                  <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(job.schedule))}</span>
                  {job.workflow_command && !isWorkflowOnly(job) && (
                    <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">workflow + agent</span>
                  )}
                  {(job.total_runs > 0 || job.skipped_runs > 0) && <span className="hidden sm:inline">{job.total_runs} runs{job.skipped_runs > 0 ? ` · ${job.skipped_runs} skipped` : ""}</span>}
                  {job.last_run_at && <span className="hidden sm:inline">Last run {timeAgo(job.last_run_at)}</span>}
                </div>
              </div>
              {(!job.active || job.waiting_runs > 0 || job.pending_runs > 0) && (
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {!job.active && <Badge variant="secondary" className="text-[10px]">Paused</Badge>}
                  {job.waiting_runs > 0 && <Badge className={`text-[10px] ${statusStyle("waiting").bg} ${statusStyle("waiting").text} hover:bg-amber-500/10`}>{job.waiting_runs} waiting</Badge>}
                  {job.pending_runs > 0 && <Badge className={`text-[10px] ${statusStyle("pending").bg} ${statusStyle("pending").text} hover:bg-violet-500/10`}>{job.pending_runs} pending</Badge>}
                </div>
              )}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">Recurring work across all agents.</p>
        </div>
        <div className="flex gap-2">
          {/* TODO(v2): "Add Existing" removed — see databases/page.tsx. No
              project_id reparent route exists; new jobs land in the active project. */}
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> New Job
          </Button>
        </div>
      </div>

      {!activeProjectId ? (
        <ScopePrompt need="project" entity="jobs" />
      ) : jobs.length === 0 ? (
        <EmptyState large icon={<Briefcase className="h-10 w-10 text-muted-foreground/40" />}>
          No jobs yet. Create one to get started.
        </EmptyState>
      ) : (
        <>
          {renderJobSection("Agent Jobs", jobs.filter(j => !isWorkflowOnly(j)))}
          {renderJobSection("Workflow Jobs", jobs.filter(j => isWorkflowOnly(j)))}
        </>
      )}

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} defaultTab="job" />
    </div>
  );
}
