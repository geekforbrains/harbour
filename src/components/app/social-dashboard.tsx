"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Copy,
  Database,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApp } from "@/components/app/app-context";
import type { SocialDashboard, SocialPlatformId } from "@/lib/social-intelligence";

type Props = {
  platform?: SocialPlatformId;
};

function toneClass(tone: "good" | "warn" | "neutral") {
  if (tone === "good") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (tone === "warn") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-foreground/10 bg-muted text-muted-foreground";
}

function statusBadge(status: string) {
  if (status === "active") return <Badge className="bg-emerald-600 text-white">Active</Badge>;
  if (status === "next") return <Badge variant="secondary">Next</Badge>;
  if (status === "coming_later") return <Badge variant="outline">Coming Later</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function policyBadge(policy: string) {
  if (policy === "not_allowed") return <Badge variant="destructive">Blocked</Badge>;
  if (policy === "manual_review_required") return <Badge className="bg-amber-600 text-white">Review</Badge>;
  if (policy === "official_api" || policy === "authorized_oauth") return <Badge className="bg-emerald-600 text-white">Authorized</Badge>;
  return <Badge variant="outline">{policy.replaceAll("_", " ")}</Badge>;
}

function distributionBadge(value: string) {
  if (value === "draft_ready") return <Badge className="bg-sky-600 text-white">Draft ready</Badge>;
  if (value === "scheduled") return <Badge className="bg-emerald-600 text-white">Scheduled</Badge>;
  if (value === "blocked") return <Badge variant="destructive">Blocked</Badge>;
  return <Badge variant="outline">Not started</Badge>;
}

export function SocialDashboard({ platform = "overview" }: Props) {
  const { activeWorkspaceId, activeProjectId } = useApp();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, refetch } = useQuery<SocialDashboard>({
    queryKey: ["social-dashboard", platform, activeWorkspaceId, activeProjectId],
    queryFn: async () => {
      const params = new URLSearchParams({ platform });
      if (activeWorkspaceId) params.set("workspaceId", activeWorkspaceId);
      if (activeProjectId) params.set("projectId", activeProjectId);
      const res = await fetch(`/api/social/dashboard?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load social dashboard");
      return res.json();
    },
  });

  const batchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/social/${platform}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          workspaceId: activeWorkspaceId,
          projectId: activeProjectId,
          query: data?.platform.activeSurface,
        }),
      });
      if (!res.ok) throw new Error("Failed to start batch");
      return res.json();
    },
  });

  if (isLoading || !data) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading Social intelligence...</div>;
  }

  const isComingLater = data.platform.status === "coming_later";

  function copyContract() {
    navigator.clipboard.writeText(data?.adapterContract || "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-7 px-1 py-2 sm:px-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Harbour Social</Badge>
            {statusBadge(data.platform.status)}
            {data.platform.buildOrder && <Badge variant="secondary">Build {data.platform.buildOrder}</Badge>}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{data.platform.label} Intelligence</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{data.platform.description}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button disabled={isComingLater || batchMutation.isPending} onClick={() => batchMutation.mutate()}>
            <Activity className="h-4 w-4" />
            {isComingLater ? "Coming later" : batchMutation.isPending ? "Starting..." : "Start batch"}
          </Button>
        </div>
      </div>

      <nav className="flex gap-2 overflow-x-auto rounded-[22px] border bg-card/80 p-1 shadow-[0_16px_40px_rgba(28,28,42,0.06)]">
        {data.platforms.map(item => {
          const active = item.id === data.platform.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`flex min-w-fit items-center gap-2 rounded-[16px] px-4 py-2 text-sm font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <span>{item.shortLabel}</span>
              {item.status === "coming_later" && <Clock className="h-3.5 w-3.5" />}
            </Link>
          );
        })}
      </nav>

      {batchMutation.data && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          Batch {batchMutation.data.id} is {batchMutation.data.status}. {batchMutation.data.message}
        </div>
      )}
      {batchMutation.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {(batchMutation.error as Error).message}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.metrics.map(metric => (
          <Card key={metric.label} size="sm" className="min-w-0 rounded-[18px] shadow-[0_12px_30px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-sm">
                <span>{metric.label}</span>
                <span className={`rounded-full border px-2 py-0.5 text-xs ${toneClass(metric.tone)}`}>{metric.value}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{metric.detail}</CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {data.sections.map(section => (
          <Card key={section.title} className="min-w-0 rounded-[20px] shadow-[0_14px_36px_rgba(28,28,42,0.08)]">
            <CardHeader className="gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 shrink-0 text-primary" />
                <span>{section.title}</span>
              </CardTitle>
              <p className="text-sm leading-6 text-muted-foreground">{section.description}</p>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {section.items.map(item => <Badge key={item} variant="secondary" className="max-w-full truncate">{item}</Badge>)}
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <div className="min-w-0 space-y-5">
          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Policy Gate
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[18px] border p-3">
                  <div className="text-xs text-muted-foreground">Access mode</div>
                  <div className="font-medium">{data.policy.accessMode.replaceAll("_", " ")}</div>
                </div>
                <div className="rounded-[18px] border p-3">
                  <div className="text-xs text-muted-foreground">Retention</div>
                  <div className="font-medium">{data.policy.dataRetentionDays ?? "source-bound"} days</div>
                </div>
              </div>
              <div className="space-y-2.5">
                {data.policy.notes.map(note => (
                  <div key={note} className="flex gap-2 text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span className="leading-6">{note}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-primary" />
                Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.distributionProviders.map(provider => (
                <div key={provider.id} className="rounded-[18px] border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{provider.label}</div>
                    {statusBadge(provider.status)}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{provider.role}</p>
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{provider.guardrail}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Ranked Signals
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.signals.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No active signals for this platform yet.
                </div>
              ) : data.signals.map(signal => (
                <div key={signal.id} className="rounded-lg border p-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{signal.platform}</Badge>
                        {policyBadge(signal.policy)}
                        {distributionBadge(signal.distribution)}
                      </div>
                      <h3 className="mt-2 text-sm font-medium">{signal.title}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {signal.creator} · {signal.topic} · {signal.hookType.replaceAll("_", " ")} · {signal.ageBucket}
                      </p>
                    </div>
                    <div className="min-w-20 rounded-lg border bg-muted px-3 py-2 text-center">
                      <div className="text-lg font-semibold">{signal.momentum}</div>
                      <div className="text-[11px] text-muted-foreground">momentum</div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <aside className="min-w-0 space-y-5">
          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" />
                Contracts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="min-w-0 overflow-hidden rounded-[18px] bg-muted p-3">
                <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{data.adapterContract}</pre>
              </div>
              <Button variant="outline" className="w-full" onClick={copyContract}>
                {copied ? <CheckCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy adapter contract"}
              </Button>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle>Worker Partition</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {data.workerPartitions.map(worker => (
                <div key={worker.queue} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{worker.queue}</span>
                    <Badge variant="outline">{worker.target}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{worker.purpose}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[22px] shadow-[0_16px_42px_rgba(28,28,42,0.08)]">
            <CardHeader>
              <CardTitle>MCP Tool Surface</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {data.mcpTools.map(tool => <Badge key={tool} variant="secondary">{tool}</Badge>)}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                MCP exposes tools to agents and downstream software. It calls FastAPI and does not process 1,000-video batches directly.
              </p>
            </CardContent>
          </Card>
        </aside>
      </section>
    </div>
  );
}
