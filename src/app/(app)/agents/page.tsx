"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Plus, Briefcase, Copy, Check, Loader2, CheckCircle, XCircle } from "lucide-react";
import { agentColor } from "@/lib/agent-color";
import { timeAgo } from "@/lib/time";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ListState } from "@/components/app/list-state";
import { RowLink } from "@/components/app/row-link";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";

type Agent = {
  id: string;
  name: string;
  description: string | null;
  cli: string | null;
  model: string | null;
  job_count: number;
  waiting_count: number;
  pending_count: number;
  last_activity: number | null;
  last_polled_at: number | null;
};

type CliTool = {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
};

import { CLI_CONFIG } from "@/lib/cli-config";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useAgents, useCreateAgent } from "@/lib/hooks/use-agents";

export default function AgentsPage() {
  const activeProjectId = useActiveProjectId();
  const createAgent = useCreateAgent();

  const { data: agentsData = [], isLoading: loading } = useAgents();
  const agents = agentsData as unknown as Agent[];

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [newAgent, setNewAgent] = useState<{ id: string; name: string; apiKey: string; cli?: string | null; model?: string | null; thinking?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [eagerAgent, setEagerAgent] = useState(false);

  // CLI tool selection — every v2 agent is a harbour CLI agent; cli is required.
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");

  async function loadCliTools() {
    setLoadingTools(true);
    const res = await fetch("/api/system/cli-tools");
    if (res.ok) setCliTools(await res.json());
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
    if (selectedModel) body.model = selectedModel;
    if (selectedThinking) body.thinking = selectedThinking;
    if (eagerAgent) body.eager = true;

    try {
      const data = await createAgent.mutateAsync(body);
      setNewAgent({
        id: data.id,
        name: data.name,
        apiKey: data.apiKey ?? "",
        cli: data.cli ?? null,
        model: data.model ?? null,
        thinking: data.thinking ?? null,
      });
      setName("");
      setDescription("");
      // Agents are created directly in the active project by useCreateAgent
      // (scoped POST); v2 has no separate project-link step.
    } catch {
      // surfaced inline; leave dialog open
    }
    setCreating(false);
  }

  function handleCopy() {
    navigator.clipboard.writeText(getConnectCommand());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCloseCreate() {
    setShowCreate(false);
    setNewAgent(null);
    setCopied(false);
    setSelectedCli(null);
    setSelectedModel("");
    setSelectedThinking("");
    setCliTools([]);
    setEagerAgent(false);
  }

  function getConnectBlob() {
    if (!newAgent) return "";
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const payload = {
      url: base,
      agentId: newAgent.id,
      apiKey: newAgent.apiKey,
      name: newAgent.name,
      cli: newAgent.cli,
      model: newAgent.model,
      thinking: newAgent.thinking,
      eager: !!eagerAgent,
    };
    if (typeof window === "undefined") return "";
    return btoa(JSON.stringify(payload));
  }

  function getConnectCommand() {
    return `harbour agent connect ${getConnectBlob()}`;
  }

  if (loading) {
    return <PageLoading />;
  }

  // Any agent without a recent poll means the runner isn't picking up work.
  const showRunnerBanner =
    agents.length > 0 &&
    !agents.some(a => a.last_polled_at && Date.now() / 1000 - a.last_polled_at < 300);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        subtitle="Your AI workforce."
        actions={
          <div className="flex gap-2">
            {/* TODO(v2): "Add Existing" removed — see databases/page.tsx. No
                project_id reparent route exists; new agents land in the active project. */}
            <Button onClick={handleOpenCreate} size="sm" disabled={!activeProjectId}>
              <Plus className="h-4 w-4 mr-1.5" /> New Agent
            </Button>
          </div>
        }
      />

      {activeProjectId && showRunnerBanner && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-amber-600">Runner not active</p>
          <p className="text-muted-foreground mt-0.5">
            You have Harbour agents but no runner polling. Run: <code className="text-xs bg-muted px-1 py-0.5 rounded">harbour agent install</code>
          </p>
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
          {agents.map(agent => (
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
                  style={{ backgroundColor: `${agentColor(agent.name)}1f`, color: agentColor(agent.name) }}
                >
                  <Bot className="h-4 w-4" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{agent.name}</span>
                  {agent.cli && (
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{agent.cli}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Briefcase className="h-3 w-3" /> {agent.job_count} jobs</span>
                  {agent.last_activity && <span>Active {timeAgo(agent.last_activity)}</span>}
                </div>
              </div>
              {agent.waiting_count > 0 && (
                <Badge className="text-[10px] bg-amber-500/10 text-amber-600 hover:bg-amber-500/10 shrink-0">{agent.waiting_count} waiting</Badge>
              )}
              {agent.pending_count > 0 && (
                <Badge className="text-[10px] bg-blue-500/10 text-blue-600 hover:bg-blue-500/10 shrink-0">{agent.pending_count} pending</Badge>
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
            // Success state — agent is created and pollable locally. The connect
            // command is always available so the agent can instead be run on
            // another machine via the remote agent runtime.
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <strong>{newAgent.name}</strong> is ready. The local runner picks it up automatically. To run it on a different machine instead, paste this connect command there:
              </p>
              <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all select-all max-h-48 overflow-y-auto">
                {getConnectCommand()}
              </div>
              <p className="text-xs text-muted-foreground">
                The command contains the agent API key. Treat it like a password. If you add workflow gates to this agent&apos;s jobs, the scripts must exist at <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.harbour-agent/workflows/</code> on the remote machine.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={handleCopy}>
                  {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Command</>}
                </Button>
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
                  {cliTools.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => tool.installed && handleCliSelect(tool.id)}
                      disabled={!tool.installed}
                      className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                        tool.installed ? "hover:border-primary hover:bg-muted/50 cursor-pointer" : "opacity-50 cursor-not-allowed"
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
                <Input id="agent-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Marketing Agent" autoFocus required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-desc">Description</Label>
                <Textarea id="agent-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this agent do?" rows={2} />
              </div>
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
                    onChange={e => setEagerAgent(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div className="text-sm">
                    <p className="font-medium">Eager polling</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      After a run finishes, poll again immediately instead of waiting 60s. Drains backlogs fast — increases LLM cost.
                    </p>
                  </div>
                </label>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => {
                  setSelectedCli(null);
                  setSelectedModel("");
                  setSelectedThinking("");
                }}>Back</Button>
                <Button type="submit" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
