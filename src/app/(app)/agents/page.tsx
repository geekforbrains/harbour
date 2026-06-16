"use client";

import { Bot, Briefcase, CheckCircle, Loader2, Plus, XCircle } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { AgentColorPicker } from "@/components/app/agent-color-picker";
import { ListState } from "@/components/app/list-state";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";
import { PageHeader, PageLoading } from "@/components/app/page-header";
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
import { timeAgo } from "@/lib/time";

type Agent = {
  id: string;
  name: string;
  description: string | null;
  cli: string | null;
  model: string | null;
  color: string | null;
  job_count: number;
  waiting_count: number;
  pending_count: number;
  last_activity: number | null;
};

type CliTool = {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
};

import { apiFetch } from "@/lib/api/client";
import { CLI_CONFIG } from "@/lib/cli-config";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import { useAgents, useCreateAgent } from "@/lib/hooks/use-agents";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useRunnerHealth } from "@/lib/hooks/use-runner-health";

export default function AgentsPage() {
  const activeProjectId = useActiveProjectId();
  const createAgent = useCreateAgent();

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
  const [eagerAgent, setEagerAgent] = useState(false);
  const [placement, setPlacement] = useState("");

  // CLI tool selection — every v2 agent is a harbour CLI agent; cli is required.
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");

  async function loadCliTools() {
    setLoadingTools(true);
    try {
      setCliTools(await apiFetch<CliTool[]>("/api/system/cli-tools"));
    } catch {
      // leave cliTools unchanged on failure
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
    setSelectedThinking("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !selectedCli) return;
    setCreating(true);

    const body: Record<string, string | boolean> = { name, description, cli: selectedCli };
    if (color) body.color = color;
    if (selectedModel) body.model = selectedModel;
    if (selectedThinking) body.thinking = selectedThinking;
    if (eagerAgent) body.eager = true;
    if (placement.trim()) body.placement = placement.trim();

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
    setEagerAgent(false);
    setPlacement("");
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
        scope={activeProjectId}
        scopeNeed="project"
        scopeEntity="agents"
        isEmpty={agents.length === 0}
        emptyIcon={<Bot className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No agents yet. Create one to get started."
      >
        <div className="grid gap-2">
          {agents.map((agent) => (
            <RowLink key={agent.id} href={`/agents/${agent.id}`}>
              {agent.waiting_count > 0 ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                  <Bot className="h-4 w-4 text-amber-500" />
                </div>
              ) : agent.pending_count > 0 ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                  <Bot className="h-4 w-4 text-blue-500" />
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
              {agent.waiting_count > 0 && (
                <Badge className="text-[10px] bg-amber-500/10 text-amber-600 hover:bg-amber-500/10 shrink-0">
                  {agent.waiting_count} waiting
                </Badge>
              )}
              {agent.pending_count > 0 && (
                <Badge className="text-[10px] bg-blue-500/10 text-blue-600 hover:bg-blue-500/10 shrink-0">
                  {agent.pending_count} pending
                </Badge>
              )}
            </RowLink>
          ))}
        </div>
      </ListState>

      <Dialog open={showCreate} onOpenChange={handleCloseCreate}>
        <DialogContent>
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
                      onClick={() => tool.installed && handleCliSelect(tool.id)}
                      disabled={!tool.installed}
                      className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                        tool.installed
                          ? "hover:border-primary hover:bg-muted/50 cursor-pointer"
                          : "opacity-50 cursor-not-allowed"
                      }`}
                    >
                      <div className="flex-1">
                        <p className="text-sm font-medium">{tool.name}</p>
                        {tool.installed && tool.version && (
                          <p className="text-xs text-muted-foreground">v{tool.version}</p>
                        )}
                      </div>
                      {tool.installed ? (
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
              {CLI_CONFIG[selectedCli] && (
                <ModelThinkingSelect
                  cli={selectedCli}
                  model={selectedModel}
                  thinking={selectedThinking}
                  onModelChange={setSelectedModel}
                  onThinkingChange={setSelectedThinking}
                  defaultThinkingLabel="Default"
                />
              )}
              <div className="rounded-md border p-3 space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eagerAgent}
                    onChange={(e) => setEagerAgent(e.target.checked)}
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
