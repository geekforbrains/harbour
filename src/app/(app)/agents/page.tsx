"use client";

import { Bot, Brain, Briefcase, CheckCircle, Folder, Loader2, Plus, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { AgentColorPicker } from "@/components/app/agent-color-picker";
import { PermissionsSelect, UnrestrictedBadge } from "@/components/app/agent-permissions";
import { ListState } from "@/components/app/list-state";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";
import { PageHeader, PageLoading } from "@/components/app/page-header";
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
import { useAgentRunnerStatus, useAgents, useCreateAgent } from "@/lib/hooks/use-agents";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useRunnerHealth } from "@/lib/hooks/use-runner-health";
import { statusStyle } from "@/lib/status";
import { timeAgo } from "@/lib/time";

type Agent = {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  cli: string | null;
  model: string | null;
  color: string | null;
  /** "enforced" (workspace policy file required) or "unrestricted" (bypass). */
  permissions?: string | null;
  job_count: number;
  waiting_count: number;
  pending_count: number;
  last_activity: number | null;
};

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
  const { data: newAgentRunnerStatus } = useAgentRunnerStatus(newAgent?.id ?? "", {
    enabled: !!newAgent,
  });
  const [placement, setPlacement] = useState("");
  const [permissions, setPermissions] = useState("enforced");

  // CLI tool selection — every v2 agent is a harbour CLI agent; cli is required.
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");

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
    // Effort always starts on a real option — no blank "default" to silently
    // submit.
    setSelectedThinking(config?.thinkingOptions[0] ?? "");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !selectedCli) return;
    setCreating(true);

    const body: Record<string, string | boolean> = { name, description, cli: selectedCli };
    if (color) body.color = color;
    if (selectedModel) body.model = selectedModel;
    if (selectedThinking) body.thinking = selectedThinking;
    if (placement.trim()) body.placement = placement.trim();
    if (permissions === "unrestricted") body.permissions = permissions;

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
    setPermissions("enforced");
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
          {agents.map((agent) => {
            const tint =
              agent.waiting_count > 0
                ? statusStyle("waiting")
                : agent.pending_count > 0
                  ? statusStyle("pending")
                  : null;
            const agentColor = resolveAgentColor(agent.color, agent.name);
            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 hover:border-foreground/20 hover:bg-accent/40 transition-colors"
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    tint ? tint.bg : ""
                  }`}
                  style={
                    tint ? undefined : { backgroundColor: `${agentColor}1f`, color: agentColor }
                  }
                >
                  <Bot className={`h-4 w-4 ${tint ? tint.fg : ""}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{agent.name}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {agent.cli && (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Brain className="h-3 w-3" /> {agent.cli}
                      </span>
                    )}
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Briefcase className="h-3 w-3" /> {agent.job_count} jobs
                    </span>
                    {!activeProjectId && (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Folder className="h-3 w-3" /> {agent.project_name}
                      </span>
                    )}
                    {agent.permissions === "unrestricted" && <UnrestrictedBadge />}
                  </div>
                </div>
                {agent.waiting_count > 0 ? (
                  <Badge
                    className={`shrink-0 text-[10px] ${statusStyle("waiting").bg} ${statusStyle("waiting").text}`}
                  >
                    {agent.waiting_count} waiting
                  </Badge>
                ) : agent.pending_count > 0 ? (
                  <Badge
                    className={`shrink-0 text-[10px] ${statusStyle("pending").bg} ${statusStyle("pending").text}`}
                  >
                    {agent.pending_count} pending
                  </Badge>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {agent.last_activity ? `Active ${timeAgo(agent.last_activity)}` : "No activity"}
                  </span>
                )}
              </Link>
            );
          })}
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
            // A live runner already serving this agent's placement + CLI needs
            // no further explanation — it just picks the work up on its next
            // poll. Only surface setup guidance when nothing is listening yet.
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <strong>{newAgent.name}</strong> is ready. The runner picks it up on its next poll,
                no further setup needed.
              </p>
              {newAgentRunnerStatus && !newAgentRunnerStatus.live && (
                <p className="text-xs text-muted-foreground">
                  If no local runner is installed yet, run{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    npm run harbour -- install
                  </code>{" "}
                  on this machine. Runners for other placements are minted in Settings → Runners.
                </p>
              )}
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
                        {tool.installed && tool.version && (
                          <p className="text-xs text-muted-foreground">v{tool.version}</p>
                        )}
                        {!tool.installed && (
                          <p className="text-xs text-muted-foreground">
                            Not detected here; a remote runner can provide it.
                          </p>
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
                />
              )}
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
              <PermissionsSelect value={permissions} onChange={setPermissions} />
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
