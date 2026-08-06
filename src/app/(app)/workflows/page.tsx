"use client";

import { Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { CreateDialog } from "@/components/app/create-dialog";
import { JobRow, type JobRowData } from "@/components/app/job-row";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";

export default function WorkflowsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const activeProjectId = useActiveProjectId();

  const { data: jobsData = [], isLoading: loading } = useJobs();
  // Workflows share the jobs API; agent jobs (kind === "agent") live at /jobs.
  const workflows = (jobsData as JobRowData[]).filter((j) => j.kind === "workflow");

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
            <JobRow
              key={wf.id}
              job={wf}
              href={`/workflows/${wf.id}`}
              showProject={!activeProjectId}
            />
          ))}
        </div>
      </ListState>

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} kind="workflow" />
    </div>
  );
}
