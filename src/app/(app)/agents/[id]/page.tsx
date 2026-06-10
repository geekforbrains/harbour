"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Brain,
  Briefcase,
  Calendar,
  Check,
  Copy,
  Cpu,
  Settings,
  Terminal,
  Trash2,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AgentColorPicker } from "@/components/app/agent-color-picker";
import { BackLink } from "@/components/app/back-link";
import { EmptyState } from "@/components/app/empty-state";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";
import { PageLoading } from "@/components/app/page-header";
import { RowLink } from "@/components/app/row-link";
import { RunStatusIcon } from "@/components/app/run-status";
import { formatSchedule, parseSchedule } from "@/components/app/schedule-picker";
import { SectionHeader } from "@/components/app/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { resolveAgentColor } from "@/lib/agent-color";
import { apiFetch } from "@/lib/api/client";
import { CLI_CONFIG } from "@/lib/cli-config";
import {
  useAgent,
  useAgentJobs,
  useAgentRuns,
  useDeleteAgent,
  useUpdateAgent,
} from "@/lib/hooks/use-agents";
import { statusStyle } from "@/lib/status";
import { timeAgo } from "@/lib/time";

// Every v2 agent is a harbour CLI agent. There is no `type` or per-agent
// `remote` flag — any agent can run on another machine via the runtime, so the
// connect-runner command is always available.
type Agent = {
  id: string;
  name: string;
  description: string | null;
  cli: string | null;
  model: string | null;
  thinking: string | null;
  color: string | null;
  eager: number | null;
  remote: number | null;
  last_polled_at: number | null;
  created_at: number;
};
type Job = {
  id: string;
  kind: "agent" | "workflow";
  name: string;
  description: string | null;
  schedule: string;
  active: number;
  total_runs: number;
  waiting_runs: number;
  pending_runs: number;
  skipped_runs: number;
  last_run_at: number | null;
  prerun_command: string | null;
  workflow_command: string | null;
};
type Run = {
  id: string;
  status: string;
  job_name: string;
  created_at: number;
  completed_at: number | null;
};

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: agentData, isLoading: agentLoading } = useAgent(id);
  const { data: jobsData } = useAgentJobs(id);
  const { data: agentRunsData } = useAgentRuns(id, 50);

  const updateAgent = useUpdateAgent(id);
  const deleteAgent = useDeleteAgent();

  const agent: Agent | null = (agentData as Agent | undefined) ?? null;
  const jobs = (Array.isArray(jobsData) ? jobsData : []) as Job[];
  const loading = agentLoading;
  const allRuns = Array.isArray(agentRunsData) ? (agentRunsData as Run[]) : [];
  const waitingRuns = allRuns.filter((r) => r.status === "waiting");
  const pendingRuns = allRuns.filter((r) => r.status === "pending");
  const recentRuns = allRuns
    .filter((r) => r.status !== "waiting" && r.status !== "pending")
    .slice(0, 10);

  // Dialogs
  const [showSettings, setShowSettings] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editThinking, setEditThinking] = useState("");
  const [editEager, setEditEager] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [connectKey, setConnectKey] = useState<string | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);

  async function handleUpdateAgent() {
    try {
      await updateAgent.mutateAsync({
        name: editName,
        description: editDesc,
        color: editColor,
        model: editModel,
        thinking: editThinking,
        eager: editEager,
      });
    } catch {
      alert("Failed to update agent");
      return;
    }
    setShowSettings(false);
    queryClient.invalidateQueries({ queryKey: ["agents"] });
  }

  async function handleDeleteAgent() {
    if (!confirm(`Delete "${agent?.name}"? All jobs and runs will be permanently removed.`)) return;
    try {
      await deleteAgent.mutateAsync(id);
    } catch {
      alert("Failed to delete agent");
      return;
    }
    router.push("/agents");
  }

  async function handleGenerateConnect() {
    try {
      const data = await apiFetch<{ apiKey: string }>(`/api/agents/${id}/rotate-key`, {
        method: "POST",
      });
      setConnectKey(data.apiKey);
    } catch {
      alert("Failed to generate connect command");
    }
  }

  function connectCommand() {
    if (!agent || !connectKey || typeof window === "undefined") return "";
    // Identity-only blob — cli/model/thinking come live from /next.
    const payload = {
      url: window.location.origin,
      agentId: agent.id,
      apiKey: connectKey,
      name: agent.name,
    };
    return `npm run harbour -- agent connect ${btoa(JSON.stringify(payload))}`;
  }

  function handleCopyConnect() {
    const cmd = connectCommand();
    if (!cmd) return;
    navigator.clipboard.writeText(cmd);
    setConnectCopied(true);
    setTimeout(() => setConnectCopied(false), 2000);
  }

  if (loading) return <PageLoading />;
  if (!agent)
    return <div className="text-sm text-muted-foreground py-12 text-center">Agent not found.</div>;

  return (
    <div className="space-y-6">
      <BackLink href="/agents" label="Agents" />

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor: `${resolveAgentColor(agent.color, agent.name)}1f`,
              color: resolveAgentColor(agent.color, agent.name),
            }}
          >
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
              {agent.cli && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {agent.cli}
                </span>
              )}
              {agent.remote ? (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  remote
                </span>
              ) : null}
            </div>
            {agent.description && (
              <p className="text-sm text-muted-foreground mt-0.5">{agent.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setConnectKey(null);
              setConnectCopied(false);
              setShowConnect(true);
            }}
            title="Connect Runner"
          >
            <Wifi className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setEditName(agent.name);
              setEditDesc(agent.description || "");
              setEditColor(agent.color || "");
              setEditModel(agent.model || "");
              setEditThinking(agent.thinking || "");
              setEditEager(!!agent.eager);
              setShowSettings(true);
            }}
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-4 rounded-lg border p-3">
        <div className="flex items-center gap-2 text-sm">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{agent.cli || "—"}</span>
        </div>
        {agent.model && (
          <div className="flex items-center gap-2 text-sm">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">{agent.model}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{agent.thinking || "Default"}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Activity className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {recentRuns.length > 0
              ? timeAgo(recentRuns[0].completed_at || recentRuns[0].created_at)
              : "No activity"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {agent.last_polled_at ? timeAgo(agent.last_polled_at) : "Never polled"}
          </span>
        </div>
      </div>

      {/* Jobs */}
      <section>
        <SectionHeader count={jobs.length}>Jobs</SectionHeader>
        {jobs.length === 0 ? (
          <EmptyState>No jobs yet.</EmptyState>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <RowLink key={job.id} href={`/jobs/${job.id}`}>
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    !job.active
                      ? "bg-muted"
                      : job.waiting_runs > 0
                        ? statusStyle("waiting").bg
                        : job.pending_runs > 0
                          ? statusStyle("pending").bg
                          : "bg-muted"
                  }`}
                >
                  <Briefcase
                    className={`h-4 w-4 ${
                      !job.active
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
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(job.schedule))}
                    </span>
                    {job.prerun_command && (
                      <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">prerun</span>
                    )}
                    {job.total_runs > 0 && (
                      <span className="hidden sm:inline">{job.total_runs} runs</span>
                    )}
                    {job.last_run_at && (
                      <span className="hidden sm:inline">Last run {timeAgo(job.last_run_at)}</span>
                    )}
                  </div>
                </div>
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
            ))}
          </div>
        )}
      </section>

      {/* Waiting Runs */}
      {waitingRuns.length > 0 && (
        <section>
          <SectionHeader count={waitingRuns.length}>Waiting</SectionHeader>
          <div className="space-y-2">
            {waitingRuns.map((run) => (
              <RowLink key={run.id} href={`/runs/${run.id}`}>
                <RunStatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{run.job_name}</span>
                </div>
                <span className="text-xs text-muted-foreground pt-1">
                  {timeAgo(run.created_at)}
                </span>
              </RowLink>
            ))}
          </div>
        </section>
      )}

      {/* Pending Runs */}
      {pendingRuns.length > 0 && (
        <section>
          <SectionHeader count={pendingRuns.length}>Pending</SectionHeader>
          <div className="space-y-2">
            {pendingRuns.map((run) => (
              <RowLink key={run.id} href={`/runs/${run.id}`}>
                <RunStatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{run.job_name}</span>
                </div>
                <span className="text-xs text-muted-foreground pt-1">
                  {timeAgo(run.created_at)}
                </span>
              </RowLink>
            ))}
          </div>
        </section>
      )}

      {/* Recent Runs */}
      <section>
        <SectionHeader>Recent Runs</SectionHeader>
        {recentRuns.length === 0 ? (
          <EmptyState>No runs yet.</EmptyState>
        ) : (
          <>
            <div className="space-y-2">
              {recentRuns.map((run) => (
                <RowLink key={run.id} href={`/runs/${run.id}`}>
                  <RunStatusIcon status={run.status} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{run.job_name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground pt-1">
                    {timeAgo(run.completed_at || run.created_at)}
                  </span>
                </RowLink>
              ))}
            </div>
            <div className="text-center pt-2">
              <Link
                href={`/runs?agentId=${id}`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View all runs for this agent →
              </Link>
            </div>
          </>
        )}
      </section>

      {/* Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Agent ID</Label>
              <div className="font-mono bg-muted rounded-lg px-3 py-2 text-xs select-all">
                {agent.id}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} />
            </div>
            <AgentColorPicker value={editColor} onChange={setEditColor} previewName={editName} />
            {agent.cli && CLI_CONFIG[agent.cli] && (
              <ModelThinkingSelect
                cli={agent.cli}
                model={editModel}
                thinking={editThinking}
                onModelChange={setEditModel}
                onThinkingChange={setEditThinking}
                defaultThinkingLabel="Default"
              />
            )}
            <div className="rounded-md border p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editEager}
                  onChange={(e) => setEditEager(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="text-sm">
                  <p className="font-medium">Eager polling</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    After a run finishes, poll again immediately instead of waiting 60s. Drains
                    backlogs fast — increases LLM cost.
                  </p>
                </div>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="destructive" onClick={handleDeleteAgent} className="mr-auto">
              <Trash2 className="h-4 w-4 mr-1" /> Delete
            </Button>
            <Button variant="ghost" onClick={() => setShowSettings(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateAgent}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect Runner Dialog — any agent can run on another machine. Generating
          a command rotates the API key, which embeds in the connect blob. */}
      <Dialog
        open={showConnect}
        onOpenChange={(open) => {
          setShowConnect(open);
          if (!open) {
            setConnectKey(null);
            setConnectCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Runner</DialogTitle>
          </DialogHeader>
          {connectKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Run this on the target machine. The command embeds a fresh API key — any
                previously-connected runner for this agent has been invalidated.
              </p>
              <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all select-all max-h-48 overflow-y-auto">
                {connectCommand()}
              </div>
              <p className="text-xs text-muted-foreground">
                The command contains the agent API key. Treat it like a password. If this
                agent&apos;s jobs use prerun commands, the scripts must exist at{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.harbour/workflows/</code>{" "}
                on that machine.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={handleCopyConnect}>
                  {connectCopied ? (
                    <>
                      <Check className="h-4 w-4 mr-1.5" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1.5" /> Copy Command
                    </>
                  )}
                </Button>
                <Button
                  onClick={() => {
                    setShowConnect(false);
                    setConnectKey(null);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {agent.remote
                  ? "Generate a connect command to register (or re-register) the machine that runs this agent. This rotates the API key — any previously-connected runner stops working until you reconnect it with the new command."
                  : "This agent runs on the local machine. Generating a connect command lets you run it elsewhere instead — it rotates the API key, so the local runner stops picking it up until reconnected."}
              </p>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowConnect(false)}>
                  Cancel
                </Button>
                <Button onClick={handleGenerateConnect}>Generate Command</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
