"use client";

import { Activity, ArrowRight } from "lucide-react";
import Link from "next/link";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { RunRow, type RunRowData } from "@/components/app/run-row";
import { SectionHeader } from "@/components/app/section-header";
import { useActiveOrgId, useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useRuns } from "@/lib/hooks/use-runs";

type Run = RunRowData;

export default function RunsPage() {
  const activeProjectId = useActiveProjectId();
  const activeOrgId = useActiveOrgId();
  const historyHref = activeProjectId ? `/runs?projectId=${activeProjectId}` : "/runs";

  const { data: runsData, isLoading: loading } = useRuns({ refetchInterval: 5000 });

  const scheduled = runsData?.scheduled || [];
  const running = runsData?.running || [];
  const allWaiting = runsData?.waiting || [];
  const waiting = allWaiting.filter((r: Run) => r.status === "waiting");
  const pending = allWaiting.filter((r: Run) => r.status === "pending");
  const recent = runsData?.recent || [];
  const collapsedActive = recent.some((r: Run) => (r.collapsed_count ?? 0) > 1);

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader title="Runs" subtitle="All run activity." />

      <ListState
        scope={activeOrgId}
        scopeNeed="org"
        scopeEntity="runs"
        isEmpty={
          running.length === 0 &&
          scheduled.length === 0 &&
          waiting.length === 0 &&
          pending.length === 0 &&
          recent.length === 0
        }
        emptyIcon={<Activity className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No runs yet."
      >
        {running.length > 0 && (
          <section>
            <SectionHeader count={running.length}>Running</SectionHeader>
            <div className="space-y-2">
              {running.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}

        {scheduled.length > 0 && (
          <section>
            <SectionHeader count={scheduled.length}>Scheduled</SectionHeader>
            <div className="space-y-2">
              {scheduled.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}

        {waiting.length > 0 && (
          <section>
            <SectionHeader count={waiting.length}>Waiting</SectionHeader>
            <div className="space-y-2">
              {waiting.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}

        {pending.length > 0 && (
          <section>
            <SectionHeader count={pending.length}>Pending</SectionHeader>
            <div className="space-y-2">
              {pending.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionHeader>Recent</SectionHeader>
          <div className="space-y-2">
            {recent.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
          {recent.length > 0 && (
            <div className="mt-3 flex flex-col items-center gap-1.5">
              {collapsedActive && (
                <p className="text-xs text-muted-foreground">
                  Repeated runs are folded into single rows.{" "}
                  <Link
                    href="/settings"
                    className="underline underline-offset-2 hover:text-foreground transition-colors"
                  >
                    Settings
                  </Link>
                </p>
              )}
              <Link
                href={historyHref}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
              >
                View all runs <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </section>
      </ListState>
    </div>
  );
}
