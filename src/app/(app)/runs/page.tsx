"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Filter, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BackLink } from "@/components/app/back-link";
import { EmptyState } from "@/components/app/empty-state";
import { SELECT_CLASS } from "@/components/app/model-thinking-select";
import { PageHeader } from "@/components/app/page-header";
import { RunRow, type RunRowData } from "@/components/app/run-row";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api/client";
import { useAgents } from "@/lib/hooks/use-agents";
import { useJobs } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useRunnerHealth } from "@/lib/hooks/use-runner-health";

type AgentLite = { id: string; name: string };
type JobLite = { id: string; name: string; agent_id: string | null };

// Order matters: matches what the dashboard treats as "real activity" first,
// terminal states next, skipped last (off by default — gated, not a real run).
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "pending", label: "Pending" },
  { value: "scheduled", label: "Scheduled" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "killed", label: "Killed" },
  { value: "skipped", label: "Skipped" },
];
const DEFAULT_STATUSES = ["running", "waiting", "pending", "done", "failed", "killed"];
const PAGE_SIZE = 25;

function setOrDelete(params: URLSearchParams, key: string, value: string | null | undefined) {
  if (value == null || value === "") params.delete(key);
  else params.set(key, value);
}

export default function RunsHistoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeProjectId = useActiveProjectId();

  // Read filters from URL (URL is the source of truth)
  const statusesFromUrl = useMemo(() => {
    const raw = searchParams.get("status");
    if (!raw) return DEFAULT_STATUSES;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [searchParams]);
  const agentId = searchParams.get("agentId") ?? "";
  const jobId = searchParams.get("jobId") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const sort = (searchParams.get("sort") === "oldest" ? "oldest" : "newest") as "newest" | "oldest";

  const projectId = searchParams.get("projectId") ?? activeProjectId ?? "";

  function updateFilters(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) setOrDelete(params, k, v);
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }

  function toggleStatus(value: string) {
    const next = new Set(statusesFromUrl);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    if (next.size === 0) {
      updateFilters({ status: null });
      return;
    }
    const arr = STATUS_OPTIONS.map((o) => o.value).filter((v) => next.has(v));
    // If the user happens to land on the default set, clear the param to keep URLs clean.
    const matchesDefault =
      arr.length === DEFAULT_STATUSES.length && arr.every((v) => DEFAULT_STATUSES.includes(v));
    updateFilters({ status: matchesDefault ? null : arr.join(",") });
  }

  function clearFilters() {
    router.replace("/runs", { scroll: false });
  }

  const { data: agentsData = [] } = useAgents();
  const agents = agentsData as unknown as AgentLite[];

  const { data: jobsData = [] } = useJobs();
  const jobs = jobsData as unknown as JobLite[];

  const { data: runnerHealth } = useRunnerHealth();
  const stalled = runnerHealth?.stalled ?? [];

  const jobsForAgent = useMemo(() => {
    if (!agentId) return jobs;
    return jobs.filter((j) => j.agent_id === agentId);
  }, [jobs, agentId]);

  function buildHistoryUrl(offset: number) {
    const params = new URLSearchParams();
    if (statusesFromUrl.join(",") !== DEFAULT_STATUSES.join(",")) {
      params.set("status", statusesFromUrl.join(","));
    } else {
      // Always send the explicit list so the server doesn't have to mirror our default
      params.set("status", DEFAULT_STATUSES.join(","));
    }
    if (agentId) params.set("agentId", agentId);
    if (jobId) params.set("jobId", jobId);
    if (from) params.set("from", String(Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000)));
    if (to) params.set("to", String(Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000)));
    if (sort) params.set("sort", sort);
    if (projectId) params.set("projectId", projectId);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return `/api/runs/history?${params.toString()}`;
  }

  // Pagination: we keep all loaded pages in state so "Load more" can append.
  const queryKey = useMemo(
    () => ["runs", "history", statusesFromUrl.join(","), agentId, jobId, from, to, sort, projectId],
    [statusesFromUrl, agentId, jobId, from, to, sort, projectId],
  );

  const [pages, setPages] = useState<RunRowData[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data: firstPage, isLoading } = useQuery<{ runs: RunRowData[]; hasMore: boolean }>({
    queryKey,
    queryFn: () =>
      apiFetch<{ runs: RunRowData[]; hasMore: boolean }>(buildHistoryUrl(0)).catch(() => ({
        runs: [],
        hasMore: false,
      })),
    refetchInterval: 5000,
  });

  // Reset pages whenever filters change / first page refreshes.
  useEffect(() => {
    if (firstPage) {
      setPages([firstPage.runs]);
      setHasMore(firstPage.hasMore);
    }
  }, [firstPage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: buildHistoryUrl is recreated each render; the filter params it closes over are listed instead so the callback stays fresh without depending on the function identity
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const currentCount = pages.reduce((n, p) => n + p.length, 0);
      const data = await apiFetch<{ runs: RunRowData[]; hasMore: boolean }>(
        buildHistoryUrl(currentCount),
      );
      setPages((prev) => [...prev, data.runs]);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [pages, statusesFromUrl, agentId, jobId, from, to, sort, projectId]);

  const allRuns = pages.flat();
  const filtersActive =
    statusesFromUrl.join(",") !== DEFAULT_STATUSES.join(",") ||
    !!agentId ||
    !!jobId ||
    !!from ||
    !!to ||
    sort !== "newest";

  // If a deep link includes jobId or agentId, surface the back link to /
  const showBackLink = !!jobId || !!agentId;

  return (
    <div className="space-y-6">
      {showBackLink && <BackLink href="/" label="Runs" />}

      <PageHeader title="All Runs" subtitle="Full run history, filterable." />

      {stalled.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-amber-600">No runner connected</p>
          <div className="text-muted-foreground mt-0.5 space-y-0.5">
            {stalled.map((s) => (
              <p key={s.placement}>
                {s.count} run(s) waiting — no runner is serving placement{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">{s.placement}</code>.
              </p>
            ))}
            <p>
              Start the local runner (
              <code className="text-xs bg-muted px-1 py-0.5 rounded">harbour run</code>/
              <code className="text-xs bg-muted px-1 py-0.5 rounded">harbour install</code>) or mint
              a runner for this placement in Settings → Runners.
            </p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-lg border p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Filter className="h-3.5 w-3.5" /> Filters
          </div>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Agent</Label>
            <select
              className={SELECT_CLASS}
              value={agentId}
              onChange={(e) => updateFilters({ agentId: e.target.value || null, jobId: null })}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Job</Label>
            <select
              className={SELECT_CLASS}
              value={jobId}
              onChange={(e) => updateFilters({ jobId: e.target.value || null })}
            >
              <option value="">All jobs</option>
              {jobsForAgent.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <input
              type="date"
              className={SELECT_CLASS}
              value={from}
              onChange={(e) => updateFilters({ from: e.target.value || null })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <input
              type="date"
              className={SELECT_CLASS}
              value={to}
              onChange={(e) => updateFilters({ to: e.target.value || null })}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Label className="text-xs mr-1">Status</Label>
            {STATUS_OPTIONS.map((opt) => {
              const on = statusesFromUrl.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleStatus(opt.value)}
                  className={`text-[11px] px-2 py-0.5 rounded-md border transition-colors ${
                    on
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Label className="text-xs">Sort</Label>
            <select
              className={`${SELECT_CLASS} w-auto min-w-[10rem]`}
              value={sort}
              onChange={(e) =>
                updateFilters({ sort: e.target.value === "oldest" ? "oldest" : null })
              }
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results */}
      {isLoading && pages.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>
      ) : allRuns.length === 0 ? (
        <EmptyState large icon={<Activity className="h-10 w-10 text-muted-foreground/40" />}>
          No runs match these filters.
        </EmptyState>
      ) : (
        <>
          <div className="space-y-2">
            {allRuns.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
          <div className="flex items-center justify-center pt-2">
            {hasMore ? (
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more`}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                End of history ({allRuns.length} runs)
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
