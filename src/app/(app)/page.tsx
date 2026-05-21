"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, Terminal, Plus, Zap, Pause, Play } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SectionHeader } from "@/components/app/section-header";
import { EmptyState } from "@/components/app/empty-state";
import { CreateDialog } from "@/components/app/create-dialog";
import { TriggerDialog } from "@/components/app/trigger-dialog";
import { timeAgo } from "@/lib/time";
import { RunStatusIcon } from "@/components/app/run-status";
import { useProjectFilter } from "@/lib/hooks/use-project-filter";
import { cn } from "@/lib/utils";

type Run = {
  id: string; status: string; job_id: string; job_name: string; job_active: number;
  agent_name: string | null; job_workflow_command: string | null; job_workflow_only: number;
  created_at: number; updated_at: number; completed_at: number | null;
};

function RunRow({ run }: { run: Run }) {
  const queryClient = useQueryClient();
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

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
      <Link href={`/runs/${run.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
        <RunStatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{run.job_name}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
            {run.job_workflow_only && !run.agent_name ? (
              <><Terminal className="h-3 w-3" /><span>Workflow</span></>
            ) : run.job_workflow_command && run.agent_name ? (
              <><Bot className="h-3 w-3" /><Terminal className="h-3 w-3" /><span>{run.agent_name}</span></>
            ) : (
              <><Bot className="h-3 w-3" /><span>{run.agent_name}</span></>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(run.completed_at || run.updated_at)}</span>
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
      </Link>
      <TriggerDialog jobId={run.job_id} jobName={run.job_name} open={triggerOpen} onOpenChange={setTriggerOpen} />
    </>
  );
}

const STATUS_META: Record<string, { title: string; description: string }> = {
  waiting:   { title: "Waiting",   description: "Runs waiting for human input or pickup." },
  running:   { title: "Running",   description: "Runs currently in progress." },
  scheduled: { title: "Scheduled", description: "Runs scheduled for the future." },
  recent:    { title: "Recent",    description: "Recently completed runs." },
};

const FILTERS = [
  { href: "/", label: "All", value: null },
  { href: "/?status=waiting", label: "Waiting", value: "waiting" },
  { href: "/?status=running", label: "Running", value: "running" },
  { href: "/?status=scheduled", label: "Scheduled", value: "scheduled" },
  { href: "/?status=recent", label: "Recent", value: "recent" },
];

export default function RunsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const projectFilter = useProjectFilter();
  const searchParams = useSearchParams();
  const statusFilter = searchParams.get("status"); // waiting | running | scheduled | recent | null

  const { data: runsData, isLoading: loading } = useQuery<{
    scheduled?: Run[];
    running?: Run[];
    waiting?: Run[];
    recent?: Run[];
  }>({
    queryKey: ["runs", projectFilter],
    queryFn: async () => {
      const res = await fetch(`/api/runs${projectFilter}`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const scheduled = runsData?.scheduled || [];
  const running = runsData?.running || [];
  const allWaiting = runsData?.waiting || [];
  const waiting = allWaiting.filter((r: Run) => r.status === "waiting");
  const pending = allWaiting.filter((r: Run) => r.status === "pending");
  const recent = runsData?.recent || [];

  // Which sections to show based on ?status filter
  const show = (section: string) => !statusFilter || statusFilter === section;

  const meta = statusFilter ? STATUS_META[statusFilter] : null;

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">{meta?.description ?? "All scheduled, active, waiting, and recent run activity."}</p>
        </div>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" /> New Run
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/20 p-1">
        {FILTERS.map(filter => {
          const active = (statusFilter || null) === filter.value;
          return (
            <Link
              key={filter.label}
              href={filter.href}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-8", active && "bg-background shadow-sm")}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      {running.length === 0 && scheduled.length === 0 && waiting.length === 0 && pending.length === 0 && recent.length === 0 ? (
        <EmptyState large icon={<Activity className="h-10 w-10 text-muted-foreground/40" />}>
          No runs yet.
        </EmptyState>
      ) : (
        <>
          {show("running") && running.length > 0 && (
            <section>
              <SectionHeader count={running.length}>Running</SectionHeader>
              <div className="space-y-2">
                {running.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {show("scheduled") && scheduled.length > 0 && (
            <section>
              <SectionHeader count={scheduled.length}>Scheduled</SectionHeader>
              <div className="space-y-2">
                {scheduled.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {show("waiting") && waiting.length > 0 && (
            <section>
              <SectionHeader count={waiting.length}>Waiting</SectionHeader>
              <div className="space-y-2">
                {waiting.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {show("waiting") && pending.length > 0 && (
            <section>
              <SectionHeader count={pending.length}>Pending</SectionHeader>
              <div className="space-y-2">
                {pending.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {show("recent") && (
            <section>
              <SectionHeader>Recent</SectionHeader>
              <div className="space-y-2">
                {recent.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}
        </>
      )}

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} defaultTab="run" />
    </div>
  );
}
