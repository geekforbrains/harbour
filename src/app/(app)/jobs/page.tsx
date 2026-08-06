"use client";

import { Briefcase, Plus } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { CreateDialog } from "@/components/app/create-dialog";
import { JobRow, type JobRowData } from "@/components/app/job-row";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { useAgents } from "@/lib/hooks/use-agents";
import { useJobs } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";

export default function JobsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const activeProjectId = useActiveProjectId();

  const { data: jobsData = [], isLoading: loading } = useJobs();
  // An agent job attaches to an agent in the active project, so creating one
  // needs both a project and at least one agent there.
  const { data: agents = [], isLoading: agentsLoading } = useAgents();
  // Workflows (kind === "workflow") have their own page at /workflows.
  const jobs = (jobsData as JobRowData[]).filter((j) => j.kind !== "workflow");

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
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              href={`/jobs/${job.id}`}
              showProject={!activeProjectId}
            />
          ))}
        </div>
      </ListState>

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} kind="agent" />
    </div>
  );
}
