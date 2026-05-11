"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Plus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/app/section-header";
import { EmptyState } from "@/components/app/empty-state";
import { CreateDialog } from "@/components/app/create-dialog";
import { RunRow, type RunRowData } from "@/components/app/run-row";
import { useProjectFilter, useActiveProjectId } from "@/lib/hooks/use-project-filter";

type Run = RunRowData;

export default function RunsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const projectFilter = useProjectFilter();
  const activeProjectId = useActiveProjectId();
  const historyHref = activeProjectId ? `/runs?projectId=${activeProjectId}` : "/runs";

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

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">All run activity.</p>
        </div>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" /> New Run
        </Button>
      </div>

      {running.length === 0 && scheduled.length === 0 && waiting.length === 0 && pending.length === 0 && recent.length === 0 ? (
        <EmptyState large icon={<Activity className="h-10 w-10 text-muted-foreground/40" />}>
          No runs yet.
        </EmptyState>
      ) : (
        <>
          {running.length > 0 && (
            <section>
              <SectionHeader count={running.length}>Running</SectionHeader>
              <div className="space-y-2">
                {running.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {scheduled.length > 0 && (
            <section>
              <SectionHeader count={scheduled.length}>Scheduled</SectionHeader>
              <div className="space-y-2">
                {scheduled.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {waiting.length > 0 && (
            <section>
              <SectionHeader count={waiting.length}>Waiting</SectionHeader>
              <div className="space-y-2">
                {waiting.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          {pending.length > 0 && (
            <section>
              <SectionHeader count={pending.length}>Pending</SectionHeader>
              <div className="space-y-2">
                {pending.map(run => <RunRow key={run.id} run={run} />)}
              </div>
            </section>
          )}

          <section>
            <SectionHeader>Recent</SectionHeader>
            <div className="space-y-2">
              {recent.map(run => <RunRow key={run.id} run={run} />)}
            </div>
            {recent.length > 0 && (
              <div className="mt-3 text-center">
                <Link href={historyHref} className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1">
                  View all runs <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            )}
          </section>
        </>
      )}

      <CreateDialog open={showCreate} onOpenChange={setShowCreate} defaultTab="run" />
    </div>
  );
}
