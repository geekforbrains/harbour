"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Plus, Briefcase, Copy, Check, Terminal, ExternalLink, Loader2, CheckCircle, XCircle } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";
import { useApp } from "@/components/app/app-context";

type Agent = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  cli: string | null;
  model: string | null;
  job_count: number;
  waiting_count: number;
  pending_count: number;
  last_activity: number | null;
  last_polled_at: number | null;
  scope_type: string;
  workspace_id: string | null;
  project_id: string | null;
  composio_cli_enabled: number;
  composio_mcp_enabled: number;
};

type CliTool = {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  composio?: { installed: boolean; path?: string; version?: string };
};

import { CLI_CONFIG } from "@/lib/cli-config";
import { useProjectFilter, useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { ProjectLinkDialog } from "@/components/app/project-link-dialog";
import { Link2 } from "lucide-react";

export default function AgentsPage() {
  const queryClient = useQueryClient();
  const { workspaces, projects, activeWorkspaceId, activeProjectId: appActiveProjectId } = useApp();
  const projectFilter = useProjectFilter();
  const activeProjectId = useActiveProjectId();

  const { data: agents = [], isLoading: loading } = useQuery<Agent[]>({
    queryKey: ["agents", projectFilter],
    queryFn: async () => {
      const res = await fetch(`/api/agents${projectFilter}`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [newAgent, setNewAgent] = useState<{ id: string; name: string; apiKey: string; type: string; remote?: boolean; cli?: string | null; model?: string | null; thinking?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [remoteAgent, setRemoteAgent] = useState(false);
  const [eagerAgent, setEagerAgent] = useState(false);
  const [scopeType, setScopeType] = useState<"global" | "workspace" | "project">("global");
  const [scopeWorkspaceId, setScopeWorkspaceId] = useState(activeWorkspaceId || "borg-interface");
  const [scopeProjectId, setScopeProjectId] = useState(appActiveProjectId || projects[0]?.id || "");
  const [composioCliEnabled, setComposioCliEnabled] = useState(false);
  const [composioMcpEnabled, setComposioMcpEnabled] = useState(false);
  const [composioToolkits, setComposioToolkits] = useState("");
  const [composioTools, setComposioTools] = useState("");
  const [nowSeconds, setNowSeconds] = useState(0);

  // Type selection
  const [agentType, setAgentType] = useState<"harbour" | "external" | null>(null);

  // CLI tool selection for harbour agents
  const [cliTools, setCliTools] = useState<CliTool[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");
  const [showLinkExisting, setShowLinkExisting] = useState(false);

  useEffect(() => {
    const updateNow = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateNow();
    const timer = window.setInterval(updateNow, 30000);
    return () => window.clearInterval(timer);
  }, []);


  async function loadCliTools() {
    setLoadingTools(true);
    const res = await fetch("/api/system/cli-tools");
    if (res.ok) setCliTools(await res.json());
    setLoadingTools(false);
  }

  function handleTypeSelect(type: "harbour" | "external") {
    setAgentType(type);
    if (type === "harbour") {
      loadCliTools();
    }
  }

  function handleCliSelect(cliId: string) {
    setSelectedCli(cliId);
    const config = CLI_CONFIG[cliId];
    setSelectedModel(config?.models[0] || "");
    setSelectedThinking("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);

    const body: Record<string, unknown> = {
      name,
      description,
      scopeType,
      workspaceId: scopeType === "workspace" ? scopeWorkspaceId : undefined,
      projectId: scopeType === "project" ? scopeProjectId : undefined,
      composioCliEnabled,
      composioMcpEnabled,
      composioToolkits,
      composioTools,
    };
    if (agentType === "harbour") {
      body.type = "harbour";
      if (selectedCli && selectedCli !== "none") {
        body.provider = selectedCli;
        body.cli = selectedCli;
        body.model = selectedModel;
        if (selectedThinking) body.thinking = selectedThinking;
      }
      if (remoteAgent) body.remote = true;
      if (eagerAgent) body.eager = true;
    }

    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      setNewAgent({
        id: data.id,
        name: data.name,
        apiKey: data.apiKey,
        type: agentType || "external",
        remote: !!data.remote,
        cli: data.cli ?? null,
        model: data.model ?? null,
        thinking: data.thinking ?? null,
      });
      setName("");
      setDescription("");
      // Auto-link to active project if one is selected
      if (activeProjectId) {
        await fetch(`/api/projects/${activeProjectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "link", type: "agent", targetId: data.id }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    }
    setCreating(false);
  }

  function getInviteText() {
    if (!newAgent) return "";
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `You're being invited to Harbour, a control plane that manages your recurring jobs, shared docs, and data stores. You poll for work, do the work, and report back.

Credentials (save these now):
- Agent ID: ${newAgent.id}
- API Key: ${newAgent.apiKey}
- Base URL: ${base}

Your main loop:
1. Check for work: GET ${base}/api/agents/${newAgent.id}/next?peek=true (Authorization: Bearer <key>)
   Returns { available: true/false }. Only proceed to step 2 if work is available — this avoids unnecessary LLM calls.
2. Claim and start work: GET ${base}/api/agents/${newAgent.id}/next
   Returns the full run context: job instructions, docs, data, activity log, and an "api" section with all available endpoints and status options for this run.
3. Do the work, then use the endpoints in the "api" section to post activity and set a final status (done/waiting/failed).

Full API spec: GET ${base}/api/guide
Do NOT copy the guide into memory — fetch it each time so you always have the latest version.`;
  }

  function handleCopy() {
    navigator.clipboard.writeText(getInviteText());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCloseCreate() {
    setShowCreate(false);
    setNewAgent(null);
    setCopied(false);
    setAgentType(null);
    setSelectedCli(null);
    setSelectedModel("");
    setSelectedThinking("");
    setCliTools([]);
    setRemoteAgent(false);
    setEagerAgent(false);
    setScopeType("global");
    setScopeWorkspaceId(activeWorkspaceId || "borg-interface");
    setScopeProjectId(appActiveProjectId || projects[0]?.id || "");
    setComposioCliEnabled(false);
    setComposioMcpEnabled(false);
    setComposioToolkits("");
    setComposioTools("");
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

  function getOrgoPayload() {
    if (!newAgent) return "";
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return JSON.stringify({
      runtime: "orgo",
      harbourUrl: base,
      agentId: newAgent.id,
      apiKey: newAgent.apiKey,
      provider: newAgent.cli,
      scope: {
        type: scopeType,
        workspaceId: scopeType === "workspace" ? scopeWorkspaceId : null,
        projectId: scopeType === "project" ? scopeProjectId : null,
      },
      composio: {
        cliEnabled: composioCliEnabled,
        mcpEnabled: composioMcpEnabled,
        toolkits: composioToolkits.split(",").map(v => v.trim()).filter(Boolean),
        tools: composioTools.split(",").map(v => v.trim()).filter(Boolean),
        mcpConfig: composioMcpEnabled ? {
          runtime: newAgent.cli || "external",
          mcpServers: {
            composio: {
              command: "composio",
              args: ["mcp", "start"],
              env: {
                COMPOSIO_TOOLKITS: composioToolkits,
                COMPOSIO_TOOLS: composioTools,
              },
            },
          },
        } : null,
      },
      bootstrap: [
        "Install the selected runtime CLI and Harbour runner.",
        "Install or link Composio if enabled: composio login; composio --install-skill composio-cli openclaw",
        "Poll Harbour with the included agent credentials.",
        "Fetch resolved Harbour skills before spawning work.",
      ],
    }, null, 2);
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;
  }

  const showRunnerBanner = agents.some(a => a.type === "harbour") && !agents.some(a => a.type === "harbour" && a.last_polled_at && nowSeconds > 0 && (nowSeconds - a.last_polled_at) < 300);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground mt-1">Your AI workforce.</p>
        </div>
        <div className="flex gap-2">
          {activeProjectId && (
            <Button variant="outline" size="sm" onClick={() => setShowLinkExisting(true)}>
              <Link2 className="h-4 w-4 mr-1.5" /> Add Existing
            </Button>
          )}
          <Button onClick={() => setShowCreate(true)} size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> New Agent
          </Button>
        </div>
      </div>

      {showRunnerBanner && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-amber-600">Runner not active</p>
          <p className="text-muted-foreground mt-0.5">
            You have Harbour agents but no runner polling. Run: <code className="text-xs bg-muted px-1 py-0.5 rounded">harbour agent install</code>
          </p>
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState large icon={<Bot className="h-10 w-10 text-muted-foreground/40" />}>
          No agents yet. Create one to get started.
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {agents.map(agent => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors"
            >
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${agent.waiting_count > 0 ? "bg-amber-500/10" : agent.pending_count > 0 ? "bg-blue-500/10" : "bg-primary/10"}`}>
                <Bot className={`h-4 w-4 ${agent.waiting_count > 0 ? "text-amber-500" : agent.pending_count > 0 ? "text-blue-500" : "text-primary"}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{agent.name}</span>
                  {agent.type === "harbour" && agent.cli && (
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
            </Link>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={handleCloseCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {newAgent ? "Agent Created" : !agentType ? "New Agent" : agentType === "harbour" && !selectedCli ? "Select CLI Tool" : "New Agent"}
            </DialogTitle>
          </DialogHeader>

          {newAgent ? (
            // Success state
            newAgent.type === "harbour" ? (
              newAgent.remote ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    <strong>{newAgent.name}</strong> is ready. On the remote machine (with harbour cloned and <code className="text-xs bg-muted px-1 py-0.5 rounded">npm install</code> done), run:
                  </p>
                  <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all select-all max-h-48 overflow-y-auto">
                    {getConnectCommand()}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The command contains the agent API key. Treat it like a password. If you add workflow gates to this agent&apos;s jobs, the scripts must exist at <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.harbour/workflows/</code> on the remote machine.
                  </p>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => { navigator.clipboard.writeText(getOrgoPayload()); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                      {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied Orgo Payload</> : <><Copy className="h-4 w-4 mr-1.5" /> Orgo Payload</>}
                    </Button>
                    <Button variant="outline" onClick={() => { navigator.clipboard.writeText(getConnectCommand()); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                      {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Command</>}
                    </Button>
                    <Button onClick={handleCloseCreate}>Done</Button>
                  </DialogFooter>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    <strong>{newAgent.name}</strong> is ready. Create a job for this agent and it will start picking up work automatically.
                  </p>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => { navigator.clipboard.writeText(getOrgoPayload()); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                      {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied Orgo Payload</> : <><Copy className="h-4 w-4 mr-1.5" /> Orgo Payload</>}
                    </Button>
                    <Button onClick={handleCloseCreate}>Done</Button>
                  </DialogFooter>
                </div>
              )
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Copy this invite and paste it into your agent. The API key won&apos;t be shown again.
                </p>
                <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all select-all max-h-64 overflow-y-auto">{getInviteText()}</div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => { navigator.clipboard.writeText(getOrgoPayload()); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                    {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied Orgo Payload</> : <><Copy className="h-4 w-4 mr-1.5" /> Orgo Payload</>}
                  </Button>
                  <Button variant="outline" onClick={handleCopy}>
                    {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Invite</>}
                  </Button>
                  <Button onClick={handleCloseCreate}>Done</Button>
                </DialogFooter>
              </div>
            )
          ) : !agentType ? (
            // Type selection
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleTypeSelect("harbour")}
                className="flex flex-col items-center gap-2 rounded-lg border-2 border-transparent hover:border-primary p-6 text-center transition-colors bg-muted/50 hover:bg-muted"
              >
                <Terminal className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-sm font-medium">Harbour Agent</p>
                  <p className="text-xs text-muted-foreground mt-1">Runs locally via CLI tool</p>
                </div>
              </button>
              <button
                onClick={() => handleTypeSelect("external")}
                className="flex flex-col items-center gap-2 rounded-lg border-2 border-transparent hover:border-primary p-6 text-center transition-colors bg-muted/50 hover:bg-muted"
              >
                <ExternalLink className="h-8 w-8 text-primary" />
                <div>
                  <p className="text-sm font-medium">External</p>
                  <p className="text-xs text-muted-foreground mt-1">Bring your own agent</p>
                </div>
              </button>
            </div>
          ) : agentType === "harbour" && !selectedCli ? (
            // CLI tool selection
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
                  <button
                    onClick={() => setSelectedCli("none")}
                    className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-muted/50 cursor-pointer"
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium">None (Workflow Only)</p>
                      <p className="text-xs text-muted-foreground">Jobs use workflow commands, no LLM</p>
                    </div>
                  </button>
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setAgentType(null)}>Back</Button>
              </DialogFooter>
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
              <div className="rounded-md border p-3 space-y-3">
                <div>
                  <p className="text-sm font-medium">Assignment</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Agents created in Harbour must be assigned to global, workspace, or project scope.</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["global", "workspace", "project"] as const).map(scope => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setScopeType(scope)}
                      className={`rounded-md border px-3 py-2 text-sm capitalize transition-colors ${scopeType === scope ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent"}`}
                    >
                      {scope}
                    </button>
                  ))}
                </div>
                {scopeType === "workspace" && (
                  <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={scopeWorkspaceId} onChange={e => setScopeWorkspaceId(e.target.value)}>
                    {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                  </select>
                )}
                {scopeType === "project" && (
                  <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={scopeProjectId} onChange={e => setScopeProjectId(e.target.value)}>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                )}
              </div>
              {agentType === "harbour" && selectedCli && selectedCli !== "none" && CLI_CONFIG[selectedCli] && (
                <ModelThinkingSelect
                  cli={selectedCli}
                  model={selectedModel}
                  thinking={selectedThinking}
                  onModelChange={setSelectedModel}
                  onThinkingChange={setSelectedThinking}
                  defaultThinkingLabel="Default"
                />
              )}
              <div className="rounded-md border p-3 space-y-3">
                <div>
                  <p className="text-sm font-medium">Composio</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Expose Composio CLI/MCP instructions and allowed tools to this agent.</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={composioCliEnabled} onChange={e => setComposioCliEnabled(e.target.checked)} />
                  Composio CLI
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={composioMcpEnabled} onChange={e => setComposioMcpEnabled(e.target.checked)} />
                  Composio MCP
                </label>
                <Input value={composioToolkits} onChange={e => setComposioToolkits(e.target.value)} placeholder="Allowed toolkits, comma separated: github,gmail,slack" />
                <Input value={composioTools} onChange={e => setComposioTools(e.target.value)} placeholder="Allowed tool slugs, comma separated" />
              </div>
              {agentType === "harbour" && (
                <div className="rounded-md border p-3 space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={remoteAgent}
                      onChange={e => setRemoteAgent(e.target.checked)}
                      className="mt-0.5"
                    />
                    <div className="text-sm">
                      <p className="font-medium">Run on a different machine</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Skip local runner setup. You&apos;ll get a connect command to paste on the remote machine (e.g. a Mac for iOS builds).
                      </p>
                    </div>
                  </label>
                </div>
              )}
              {agentType === "harbour" && (
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
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => {
                  if (agentType === "harbour") {
                    setSelectedCli(null);
                    setSelectedModel("");
                    setSelectedThinking("");
                  } else {
                    setAgentType(null);
                  }
                }}>Back</Button>
                <Button type="submit" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {activeProjectId && (
        <ProjectLinkDialog
          open={showLinkExisting}
          onOpenChange={setShowLinkExisting}
          projectId={activeProjectId}
          type="agent"
          queryKey="agents"
          fetchAllUrl="/api/agents"
          icon={Bot}
          title="Add Existing Agent"
        />
      )}
    </div>
  );
}
