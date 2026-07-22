"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Brain,
  Briefcase,
  Calendar,
  Cpu,
  Folder,
  Plug,
  Settings,
  Terminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AgentColorPicker } from "@/components/app/agent-color-picker";
import { BackLink } from "@/components/app/back-link";
import { EmptyState } from "@/components/app/empty-state";
import {
  modelErrorForProvider,
  modelPlaceholderForProvider,
  modelSuggestionsForProvider,
} from "@/components/app/llm-connection-form";
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
import { CLI_CONFIG } from "@/lib/cli-config";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import {
  useAgent,
  useAgentJobs,
  useAgentRuns,
  useDeleteAgent,
  useUpdateAgent,
} from "@/lib/hooks/use-agents";
import { useLlmConnections } from "@/lib/hooks/use-llm-connections";
import { statusStyle } from "@/lib/status";
import { timeAgo } from "@/lib/time";

// Every v2 agent is a harbour CLI agent. Where it runs is controlled by
// `placement` — a label routed to whichever runner advertises it. Remote runners
// are minted in Settings → Runners, not per-agent.
type Agent = {
  id: string;
  project_id: string;
  name: string;
  /** Workspace folder segment — assigned at creation, immutable on rename. */
  slug?: string | null;
  description: string | null;
  cli: string | null;
  model: string | null;
  thinking: string | null;
  llm_connection_id: string | null;
  llm_connection: {
    id: string;
    name: string;
    kind: string;
    provider_id: string;
  } | null;
  color: string | null;
  eager: number | null;
  /** Runner label this agent's runs route to; defaults to "local". */
  placement: string | null;
  created_at: number;
  /** Slug path segments for the agent's on-disk workspace on the runner. */
  workspace?: { project: string; agent: string } | null;
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
  prerun_script: string | null;
  workflow_script: string | null;
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
  const [editPlacement, setEditPlacement] = useState("");
  const [editConnectionId, setEditConnectionId] = useState("");
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const { data: llmConnections = [] } = useLlmConnections(
    { projectId: agent?.project_id },
    { enabled: agent?.cli === "opencode" && !!agent.project_id },
  );
  const editConnection =
    llmConnections.find((connection) => connection.id === editConnectionId) ??
    (agent?.llm_connection?.id === editConnectionId ? agent.llm_connection : undefined);

  async function handleUpdateAgent() {
    if (!agent) return;
    setSettingsError(null);
    if (agent.cli === "opencode") {
      if (!editConnectionId || !editConnection) {
        setSettingsError("Select an LLM connection.");
        return;
      }
      const modelError = modelErrorForProvider(editConnection.provider_id, editModel);
      if (modelError) {
        setSettingsError(modelError);
        return;
      }
    }
    try {
      await updateAgent.mutateAsync({
        name: editName,
        description: editDesc,
        color: editColor,
        model: editModel,
        thinking: editThinking,
        placement: editPlacement.trim() || "local",
        ...(agent.cli === "opencode" ? { llm_connection_id: editConnectionId } : {}),
      });
    } catch {
      return; // surfaced inline from updateAgent.error; leave dialog open
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
              setEditName(agent.name);
              setEditDesc(agent.description || "");
              setEditColor(agent.color || "");
              setEditModel(agent.model || "");
              // Select-type effort (claude/codex) always lands on a real
              // option, even for an agent saved before this field was
              // required. OpenCode's free-text variant stays optional.
              const cliConfig = agent.cli ? CLI_CONFIG[agent.cli] : undefined;
              const fallbackThinking =
                cliConfig && cliConfig.thinkingInput !== "text" ? cliConfig.thinkingOptions[0] : "";
              setEditThinking(agent.thinking || fallbackThinking);
              setEditPlacement(agent.placement || "local");
              setEditConnectionId(agent.llm_connection_id || agent.llm_connection?.id || "");
              setSettingsError(null);
              updateAgent.reset();
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
        {agent.cli === "opencode" && agent.llm_connection && (
          <div className="flex items-center gap-2 text-sm">
            <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{agent.llm_connection.name}</span>
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
        {agent.workspace && (
          <div className="col-span-2 sm:col-span-3 flex items-center gap-2 text-sm">
            <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span
              className="text-xs font-mono text-muted-foreground truncate"
              title="Working directory under the runner's HARBOUR_HOME (default ~/.harbour)"
            >
              workspaces/{agent.workspace.project}/{agent.workspace.agent}
            </span>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Runs on another machine? Mint a runner in Settings → Runners and enroll it with{" "}
        <code>npm run harbour-agent -- connect</code>.
      </p>

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
                    {job.prerun_script && (
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
            {agent.cli === "opencode" && (
              <div className="space-y-1">
                <Label htmlFor="agent-edit-connection">LLM connection</Label>
                <select
                  id="agent-edit-connection"
                  value={editConnectionId}
                  onChange={(event) => {
                    setEditConnectionId(event.target.value);
                    setEditModel("");
                  }}
                  className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  <option value="">Select a connection</option>
                  {llmConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} ({connection.provider_id})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Manage provider endpoints and keys under LLM Connections.
                </p>
              </div>
            )}
            {agent.cli && CLI_CONFIG[agent.cli] && (
              <ModelThinkingSelect
                cli={agent.cli}
                model={editModel}
                thinking={editThinking}
                onModelChange={setEditModel}
                onThinkingChange={setEditThinking}
                modelPlaceholder={
                  agent.cli === "opencode" && editConnection
                    ? modelPlaceholderForProvider(editConnection.provider_id)
                    : undefined
                }
                modelSuggestions={
                  agent.cli === "opencode" && editConnection
                    ? modelSuggestionsForProvider(editConnection.provider_id)
                    : undefined
                }
              />
            )}
            <div className="space-y-1">
              <Label>Placement</Label>
              <Input
                value={editPlacement}
                onChange={(e) => setEditPlacement(e.target.value)}
                placeholder="local"
              />
              <p className="text-xs text-muted-foreground">
                Runner label this agent's runs route to. Leave as <code>local</code> for the local
                runner; use a custom label to target a runner minted in Settings → Runners.
              </p>
            </div>
            {updateAgent.isError && (
              <p className="text-xs text-destructive">
                {mutationErrorMessage(updateAgent.error, "Failed to update agent")}
              </p>
            )}
            {settingsError && <p className="text-xs text-destructive">{settingsError}</p>}
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
    </div>
  );
}
