"use client";

import { Bot, Briefcase, CheckCircle, Loader2, Plus, XCircle } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { AgentColorPicker } from "@/components/app/agent-color-picker";
import { ListState } from "@/components/app/list-state";
import {
  buildLlmConnectionInput,
  createLlmConnectionDraft,
  LlmConnectionFields,
  modelErrorForProvider,
  modelPlaceholderForProvider,
  modelSuggestionsForProvider,
  validateLlmConnectionDraft,
} from "@/components/app/llm-connection-form";
import { ModelThinkingSelect, SELECT_CLASS } from "@/components/app/model-thinking-select";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ProjectBadge } from "@/components/app/project-badge";
import { RowLink } from "@/components/app/row-link";
import { SlugPreview } from "@/components/app/slug-preview";
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
import { CLI_CONFIG, type CliTool, mergeSupportedCliTools } from "@/lib/cli-config";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import { useAgents, useCreateAgent } from "@/lib/hooks/use-agents";
import { useEnvVars } from "@/lib/hooks/use-env-vars";
import { useCreateLlmConnection, useLlmConnections } from "@/lib/hooks/use-llm-connections";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useRunnerHealth } from "@/lib/hooks/use-runner-health";
import { timeAgo } from "@/lib/time";

type Agent = {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  cli: string | null;
  model: string | null;
  color: string | null;
  job_count: number;
  waiting_count: number;
  pending_count: number;
  last_activity: number | null;
};

export default function AgentsPage() {
  const activeProjectId = useActiveProjectId();
  const createAgent = useCreateAgent();
  const createLlmConnection = useCreateLlmConnection();

  const { data: agentsData = [], isLoading: loading } = useAgents();
  const agents = agentsData as unknown as Agent[];

  const { data: runnerHealth } = useRunnerHealth();
  const stalled = runnerHealth?.stalled ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [creating, setCreating] = useState(false);
  const [newAgent, setNewAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [placement, setPlacement] = useState("");

  // CLI tool selection — every v2 agent is a harbour CLI agent; cli is required.
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");
  const [connectionMode, setConnectionMode] = useState<"existing" | "new">("existing");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [connectionDraft, setConnectionDraft] = useState(createLlmConnectionDraft());
  const [formError, setFormError] = useState<string | null>(null);

  const isOpenCode = selectedCli === "opencode";
  const { data: llmConnections = [] } = useLlmConnections(undefined, {
    enabled: showCreate && isOpenCode,
  });
  const { data: envVars = [] } = useEnvVars(undefined, {
    enabled: showCreate && isOpenCode && connectionMode === "new",
  });
  const resolvedConnectionId = selectedConnectionId || llmConnections[0]?.id || "";
  const selectedConnection = llmConnections.find(
    (connection) => connection.id === resolvedConnectionId,
  );
  const selectedProviderId =
    connectionMode === "new" ? connectionDraft.providerId.trim() : selectedConnection?.provider_id;

  async function loadCliTools() {
    setLoadingTools(true);
    try {
      const detected = await apiFetch<CliTool[]>("/api/system/cli-tools");
      setCliTools(mergeSupportedCliTools(detected));
    } catch {
      setCliTools(mergeSupportedCliTools([]));
    }
    setLoadingTools(false);
  }

  function handleOpenCreate() {
    setShowCreate(true);
    loadCliTools();
  }

  function handleCliSelect(cliId: string) {
    setSelectedCli(cliId);
    const config = CLI_CONFIG[cliId];
    setSelectedModel(config?.models[0] || "");
    // Select-type effort (claude/codex) always starts on a real option — no
    // blank "default" to silently submit. OpenCode's free-text variant stays
    // optional, so it starts empty.
    setSelectedThinking(config && config.thinkingInput !== "text" ? config.thinkingOptions[0] : "");
    setConnectionMode("existing");
    setSelectedConnectionId("");
    setConnectionDraft(createLlmConnectionDraft());
    setFormError(null);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !selectedCli) return;
    setCreating(true);
    setFormError(null);

    let llmConnectionId: string | undefined;
    if (selectedCli === "opencode") {
      if (!selectedProviderId) {
        setFormError("Select an LLM connection or create a new one.");
        setCreating(false);
        return;
      }
      const modelError = modelErrorForProvider(selectedProviderId, selectedModel);
      if (modelError) {
        setFormError(modelError);
        setCreating(false);
        return;
      }
      if (connectionMode === "new") {
        const connectionError = validateLlmConnectionDraft(connectionDraft);
        if (connectionError) {
          setFormError(connectionError);
          setCreating(false);
          return;
        }
        try {
          const connection = await createLlmConnection.mutateAsync(
            buildLlmConnectionInput(connectionDraft),
          );
          llmConnectionId = connection.id;
          setConnectionMode("existing");
          setSelectedConnectionId(connection.id);
        } catch (error) {
          setFormError(mutationErrorMessage(error, "Failed to create LLM connection"));
          setCreating(false);
          return;
        }
      } else {
        llmConnectionId = resolvedConnectionId;
      }
    }

    const body: Record<string, string | boolean> = { name, description, cli: selectedCli };
    if (color) body.color = color;
    if (selectedModel) body.model = selectedModel;
    if (selectedThinking) body.thinking = selectedThinking;
    if (placement.trim()) body.placement = placement.trim();
    if (llmConnectionId) body.llm_connection_id = llmConnectionId;

    try {
      const data = await createAgent.mutateAsync(body);
      setNewAgent({
        id: data.id,
        name: data.name,
      });
      setName("");
      setDescription("");
      setColor("");
      // Agents are created directly in the active project by useCreateAgent
      // (scoped POST); v2 has no separate project-link step.
    } catch {
      // surfaced inline; leave dialog open
    }
    setCreating(false);
  }

  function handleCloseCreate() {
    setShowCreate(false);
    setNewAgent(null);
    setColor("");
    createAgent.reset();
    setSelectedCli(null);
    setSelectedModel("");
    setSelectedThinking("");
    setCliTools([]);
    setPlacement("");
    setConnectionMode("existing");
    setSelectedConnectionId("");
    setConnectionDraft(createLlmConnectionDraft());
    setFormError(null);
  }

  if (loading) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        subtitle="Your AI workforce."
        actions={
          <div className="flex gap-2">
            {/* TODO(v2): "Add Existing" removed — see tables/page.tsx. No
                project_id reparent route exists; new agents land in the active project. */}
            <ActionTooltip
              hint={activeProjectId ? undefined : "Select a project to create an agent."}
            >
              <Button onClick={handleOpenCreate} size="sm" disabled={!activeProjectId}>
                <Plus className="h-4 w-4 mr-1.5" /> New Agent
              </Button>
            </ActionTooltip>
          </div>
        }
      />

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

      <ListState
        isEmpty={agents.length === 0}
        emptyIcon={<Bot className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage={
          activeProjectId
            ? "No agents yet. Create one to get started."
            : "Select a project to create an agent."
        }
      >
        <div className="grid gap-2">
          {agents.map((agent) => (
            <RowLink key={agent.id} href={`/agents/${agent.id}`}>
              {agent.waiting_count > 0 ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                  <Bot className="h-4 w-4 text-amber-500" />
                </div>
              ) : agent.pending_count > 0 ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                  <Bot className="h-4 w-4 text-violet-500" />
                </div>
              ) : (
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `${resolveAgentColor(agent.color, agent.name)}1f`,
                    color: resolveAgentColor(agent.color, agent.name),
                  }}
                >
                  <Bot className="h-4 w-4" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{agent.name}</span>
                  {agent.cli && (
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {agent.cli}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Briefcase className="h-3 w-3" /> {agent.job_count} jobs
                  </span>
                  {agent.last_activity && <span>Active {timeAgo(agent.last_activity)}</span>}
                </div>
              </div>
              {!activeProjectId && <ProjectBadge name={agent.project_name} />}
              {agent.waiting_count > 0 && (
                <Badge className="text-[10px] bg-amber-500/10 text-amber-600 hover:bg-amber-500/10 shrink-0">
                  {agent.waiting_count} waiting
                </Badge>
              )}
              {agent.pending_count > 0 && (
                <Badge className="text-[10px] bg-violet-500/10 text-violet-600 hover:bg-violet-500/10 shrink-0">
                  {agent.pending_count} pending
                </Badge>
              )}
            </RowLink>
          ))}
        </div>
      </ListState>

      <Dialog open={showCreate} onOpenChange={handleCloseCreate}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {newAgent ? "Agent Created" : !selectedCli ? "Select CLI Tool" : "New Agent"}
            </DialogTitle>
          </DialogHeader>

          {newAgent ? (
            // The runner advertising this agent's placement picks it up on its
            // next poll — no further setup needed here.
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <strong>{newAgent.name}</strong> is ready. The runner picks it up on its next poll —
                no further setup needed.
              </p>
              <p className="text-xs text-muted-foreground">
                If no local runner is installed yet, run{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  npm run harbour -- install
                </code>{" "}
                on this machine. Runners for other placements are minted in Settings → Runners.
              </p>
              <DialogFooter>
                <Button onClick={handleCloseCreate}>Done</Button>
              </DialogFooter>
            </div>
          ) : !selectedCli ? (
            // CLI tool selection — required; every agent is a harbour CLI agent.
            <div className="space-y-3">
              {loadingTools ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Detecting CLI tools...</span>
                </div>
              ) : (
                <div className="grid gap-2">
                  {cliTools.map((tool) => (
                    <button
                      type="button"
                      key={tool.id}
                      onClick={() => handleCliSelect(tool.id)}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-muted/50"
                    >
                      <div className="flex-1">
                        <p className="text-sm font-medium">{tool.name}</p>
                        {tool.installed && tool.compatible !== false && tool.version && (
                          <p className="text-xs text-muted-foreground">v{tool.version}</p>
                        )}
                        {tool.installed && tool.compatible === false && (
                          <p className="text-xs text-amber-600">
                            {tool.version ? `v${tool.version} · ` : ""}
                            {tool.compatibilityReason || "Unsupported local version"}; a remote
                            runner can still provide it.
                          </p>
                        )}
                        {!tool.installed && (
                          <p className="text-xs text-muted-foreground">
                            Not detected here; a remote runner can provide it.
                          </p>
                        )}
                      </div>
                      {tool.installed && tool.compatible !== false ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Name + details form
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Marketing Agent"
                  autoFocus
                  required
                />
                <SlugPreview name={name} label="Workspace folder" />
                {createAgent.isError && (
                  <p className="text-xs text-destructive">
                    {mutationErrorMessage(createAgent.error, "Failed to create agent")}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-desc">Description</Label>
                <Textarea
                  id="agent-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this agent do?"
                  rows={2}
                />
              </div>
              <AgentColorPicker value={color} onChange={setColor} previewName={name} />
              {isOpenCode && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">LLM connection</p>
                      <p className="text-xs text-muted-foreground">
                        Provider endpoint and credentials used by OpenCode.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setConnectionMode(connectionMode === "new" ? "existing" : "new");
                        setSelectedModel("");
                        setFormError(null);
                      }}
                    >
                      {connectionMode === "new" ? "Use existing" : "New connection"}
                    </Button>
                  </div>

                  {connectionMode === "existing" ? (
                    <div className="space-y-2">
                      <Label htmlFor="agent-llm-connection">Connection</Label>
                      <select
                        id="agent-llm-connection"
                        value={resolvedConnectionId}
                        onChange={(event) => {
                          setSelectedConnectionId(event.target.value);
                          setSelectedModel("");
                        }}
                        className={SELECT_CLASS}
                      >
                        {llmConnections.length === 0 && (
                          <option value="">No connections in this project</option>
                        )}
                        {llmConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name} ({connection.provider_id})
                          </option>
                        ))}
                      </select>
                      {llmConnections.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Create a connection here to continue.
                        </p>
                      )}
                    </div>
                  ) : (
                    <LlmConnectionFields
                      draft={connectionDraft}
                      onChange={(draft) => {
                        if (draft.providerId !== connectionDraft.providerId) setSelectedModel("");
                        setConnectionDraft(draft);
                      }}
                      secrets={envVars}
                    />
                  )}
                </div>
              )}
              {CLI_CONFIG[selectedCli] && (!isOpenCode || selectedProviderId) && (
                <ModelThinkingSelect
                  cli={selectedCli}
                  model={selectedModel}
                  thinking={selectedThinking}
                  onModelChange={setSelectedModel}
                  onThinkingChange={setSelectedThinking}
                  modelPlaceholder={
                    isOpenCode && selectedProviderId
                      ? modelPlaceholderForProvider(selectedProviderId)
                      : undefined
                  }
                  modelSuggestions={
                    isOpenCode && selectedProviderId
                      ? modelSuggestionsForProvider(selectedProviderId)
                      : undefined
                  }
                />
              )}
              {formError && <p className="text-xs text-destructive">{formError}</p>}
              <div className="space-y-2">
                <Label htmlFor="agent-placement">Placement</Label>
                <Input
                  id="agent-placement"
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value)}
                  placeholder="local"
                />
                <p className="text-xs text-muted-foreground">
                  Which runner pool runs this agent (default: local).
                </p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSelectedCli(null);
                    setSelectedModel("");
                    setSelectedThinking("");
                    setConnectionMode("existing");
                    setSelectedConnectionId("");
                    setConnectionDraft(createLlmConnectionDraft());
                    setFormError(null);
                    createAgent.reset();
                  }}
                >
                  Back
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
