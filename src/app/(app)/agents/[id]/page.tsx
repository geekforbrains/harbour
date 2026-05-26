"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/app/section-header";
import { EmptyState } from "@/components/app/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BackLink } from "@/components/app/back-link";
import { parseSchedule, formatSchedule } from "@/components/app/schedule-picker";
import {
  Bot, Settings, Key, Copy, Check, Calendar, Activity, Wifi, FileText,
  Briefcase, Trash2, Terminal, Cpu, Brain,
} from "lucide-react";
import { timeAgo } from "@/lib/time";
import { RunStatusIcon } from "@/components/app/run-status";
import { statusStyle } from "@/lib/status";
import { agentColor } from "@/lib/agent-color";

import { CLI_CONFIG } from "@/lib/cli-config";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";

type Agent = { id: string; name: string; description: string | null; type: string; cli: string | null; model: string | null; thinking: string | null; remote: number | null; eager: number | null; last_polled_at: number | null; created_at: number };
type Job = { id: string; name: string; description: string | null; schedule: string; active: number; total_runs: number; waiting_runs: number; pending_runs: number; skipped_runs: number; last_run_at: number | null; workflow_command: string | null; workflow_only: number };
type Run = { id: string; status: string; job_name: string; created_at: number; completed_at: number | null };

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: agentData, isLoading: agentLoading } = useQuery({
    queryKey: ["agents", id],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${id}`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 5000,
  });

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ["agents", id, "jobs"],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${id}/jobs`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
  });

  const { data: agentRunsData = [] } = useQuery({
    queryKey: ["agents", id, "runs"],
    queryFn: async () => {
      // Pull enough that all waiting/pending are likely covered and we have a recent feed.
      const res = await fetch(`/api/agents/${id}/runs?limit=50`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
  });

  const agent: Agent | null = agentData ?? null;
  const loading = agentLoading;
  const allRuns = Array.isArray(agentRunsData) ? (agentRunsData as Run[]) : [];
  const waitingRuns = allRuns.filter(r => r.status === "waiting");
  const pendingRuns = allRuns.filter(r => r.status === "pending");
  const recentRuns = allRuns
    .filter(r => r.status !== "waiting" && r.status !== "pending")
    .slice(0, 10);

  // Dialogs
  const [showSettings, setShowSettings] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editThinking, setEditThinking] = useState("");
  const [editEager, setEditEager] = useState(false);
  const [showRotateKey, setShowRotateKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [connectCopied, setConnectCopied] = useState(false);

  async function handleUpdateAgent() {
    const body: Record<string, string | boolean> = { name: editName, description: editDesc };
    if (agent?.type === "harbour") {
      body.model = editModel;
      body.thinking = editThinking;
      body.eager = editEager;
    }
    const res = await fetch(`/api/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { alert("Failed to update agent"); return; }
    setShowSettings(false);
    queryClient.invalidateQueries({ queryKey: ["agents"] });
  }

  async function handleDeleteAgent() {
    if (!confirm(`Delete "${agent?.name}"? All jobs and runs will be permanently removed.`)) return;
    const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    if (!res.ok) { alert("Failed to delete agent"); return; }
    router.push("/agents");
  }

  async function handleRotateKey() {
    const res = await fetch(`/api/agents/${id}/rotate-key`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      setNewApiKey(data.apiKey);
    }
  }

  function handleCopy() {
    if (newApiKey) {
      navigator.clipboard.writeText(newApiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function getInviteText() {
    if (!agent) return "";
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `You're being invited to Harbour, a control plane that manages your recurring jobs, shared docs, and data stores.

Save these credentials to your memory now:
- Agent ID: ${agent.id}
- API Key: <use your existing key, or rotate from the dashboard>
- Base URL: ${base}
- Poll endpoint: GET ${base}/api/agents/${agent.id}/next (Authorization: Bearer <key>)
- Guide: GET ${base}/api/guide

IMPORTANT: Read the full guide at the URL above before doing anything. Do NOT copy the guide contents into your memory — fetch it each time you need to reference it so you always have the latest version.

The guide covers everything: polling, scheduling, run lifecycle, docs, databases, and the full API. Follow it exactly.`;
  }

  function handleCopyInvite() {
    navigator.clipboard.writeText(getInviteText());
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;
  if (!agent) return <div className="text-sm text-muted-foreground py-12 text-center">Agent not found.</div>;

  return (
    <div className="space-y-6">
      <BackLink href="/agents" label="Agents" />

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${agentColor(agent.name)}1f`, color: agentColor(agent.name) }}
          >
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
              {agent.type === "harbour" && agent.cli && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{agent.cli}</span>
              )}
            </div>
            {agent.description && <p className="text-sm text-muted-foreground mt-0.5">{agent.description}</p>}
          </div>
        </div>
        <div className="flex gap-1.5">
          {agent.type === "external" && (
            <>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setShowInvite(true)} title="Copy Invite">
                <FileText className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setShowRotateKey(true)} title="API Key">
                <Key className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {agent.type === "harbour" && agent.remote ? (
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setShowConnect(true)} title="Connect Remote Runner">
              <Wifi className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => { setEditName(agent.name); setEditDesc(agent.description || ""); setEditModel(agent.model || ""); setEditThinking(agent.thinking || ""); setEditEager(!!agent.eager); setShowSettings(true); }} title="Settings">
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-4 rounded-lg border p-3">
        <div className="flex items-center gap-2 text-sm">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{agent.type === "harbour" ? "Harbour" : "External"}</span>
        </div>
        {agent.type === "harbour" && agent.model && (
          <div className="flex items-center gap-2 text-sm">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">{agent.model}</span>
          </div>
        )}
        {agent.type === "harbour" && agent.cli && (
          <div className="flex items-center gap-2 text-sm">
            <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">{agent.thinking || "Default"}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Activity className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{recentRuns.length > 0 ? timeAgo(recentRuns[0].completed_at || recentRuns[0].created_at) : "No activity"}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{agent.last_polled_at ? timeAgo(agent.last_polled_at) : "Never polled"}</span>
        </div>
      </div>

      {/* Jobs */}
      <section>
        <SectionHeader count={jobs.length}>Jobs</SectionHeader>
        {jobs.length === 0 ? (
          <EmptyState>No jobs yet.</EmptyState>
        ) : (
          <div className="space-y-2">
            {jobs.map(job => (
              <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  !job.active ? "bg-muted" : job.waiting_runs > 0 ? statusStyle("waiting").bg : job.pending_runs > 0 ? statusStyle("pending").bg : "bg-muted"
                }`}>
                  <Briefcase className={`h-4 w-4 ${
                    !job.active ? "text-muted-foreground" : job.waiting_runs > 0 ? statusStyle("waiting").fg : job.pending_runs > 0 ? statusStyle("pending").fg : "text-muted-foreground"
                  }`} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{job.name}</span>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 mt-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {formatSchedule(parseSchedule(job.schedule))}</span>
                    {job.total_runs > 0 && <span className="hidden sm:inline">{job.total_runs} runs</span>}
                    {job.last_run_at && <span className="hidden sm:inline">Last run {timeAgo(job.last_run_at)}</span>}
                  </div>
                </div>
                {(!job.active || job.waiting_runs > 0 || job.pending_runs > 0) && (
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!job.active && <Badge variant="secondary" className="text-[10px]">Paused</Badge>}
                    {job.waiting_runs > 0 && <Badge className={`text-[10px] ${statusStyle("waiting").bg} ${statusStyle("waiting").text} hover:bg-amber-500/10`}>{job.waiting_runs} waiting</Badge>}
                    {job.pending_runs > 0 && <Badge className={`text-[10px] ${statusStyle("pending").bg} ${statusStyle("pending").text} hover:bg-violet-500/10`}>{job.pending_runs} pending</Badge>}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Waiting Runs */}
      {waitingRuns.length > 0 && (
        <section>
          <SectionHeader count={waitingRuns.length}>Waiting</SectionHeader>
          <div className="space-y-2">
            {waitingRuns.map(run => (
              <Link key={run.id} href={`/runs/${run.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
                <RunStatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{run.job_name}</span>
                </div>
                <span className="text-xs text-muted-foreground pt-1">{timeAgo(run.created_at)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Pending Runs */}
      {pendingRuns.length > 0 && (
        <section>
          <SectionHeader count={pendingRuns.length}>Pending</SectionHeader>
          <div className="space-y-2">
            {pendingRuns.map(run => (
              <Link key={run.id} href={`/runs/${run.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
                <RunStatusIcon status={run.status} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{run.job_name}</span>
                </div>
                <span className="text-xs text-muted-foreground pt-1">{timeAgo(run.created_at)}</span>
              </Link>
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
              {recentRuns.map(run => (
                <Link key={run.id} href={`/runs/${run.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
                  <RunStatusIcon status={run.status} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{run.job_name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground pt-1">{timeAgo(run.completed_at || run.created_at)}</span>
                </Link>
              ))}
            </div>
            <div className="text-center pt-2">
              <Link href={`/runs?agentId=${id}`} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                View all runs for this agent →
              </Link>
            </div>
          </>
        )}
      </section>

      {/* Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogHeader><DialogTitle>Agent Settings</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Agent ID</Label>
              <div className="font-mono bg-muted rounded-lg px-3 py-2 text-xs select-all">{agent.id}</div>
            </div>
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} />
            </div>
            {agent.type === "harbour" && agent.cli && CLI_CONFIG[agent.cli] && (
              <ModelThinkingSelect
                cli={agent.cli}
                model={editModel}
                thinking={editThinking}
                onModelChange={setEditModel}
                onThinkingChange={setEditThinking}
                defaultThinkingLabel="Default"
              />
            )}
            {agent.type === "harbour" && (
              <div className="rounded-md border p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editEager}
                    onChange={e => setEditEager(e.target.checked)}
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
          </div>
          <DialogFooter>
            <Button variant="destructive" onClick={handleDeleteAgent} className="mr-auto"><Trash2 className="h-4 w-4 mr-1" /> Delete</Button>
            <Button variant="ghost" onClick={() => setShowSettings(false)}>Cancel</Button>
            <Button onClick={handleUpdateAgent}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Key Dialog */}
      <Dialog open={showRotateKey} onOpenChange={(open) => { setShowRotateKey(open); if (!open) { setNewApiKey(null); setCopied(false); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>API Key</DialogTitle></DialogHeader>
          {newApiKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Save this key now — it won&apos;t be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all select-all">{newApiKey}</code>
                <Button variant="outline" size="icon" onClick={handleCopy} className="shrink-0">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <DialogFooter><Button onClick={() => { setShowRotateKey(false); setNewApiKey(null); }}>Done</Button></DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Rotating the API key will invalidate the current key. The agent will need to be updated with the new key.</p>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowRotateKey(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleRotateKey}>Rotate Key</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Invite Dialog */}
      <Dialog open={showInvite} onOpenChange={(open) => { setShowInvite(open); if (!open) setInviteCopied(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Agent Invite</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Copy and paste this into your agent. You&apos;ll need to add the API key separately.</p>
            <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all select-all max-h-64 overflow-y-auto">{getInviteText()}</div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCopyInvite}>
                {inviteCopied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Invite</>}
              </Button>
              <Button onClick={() => setShowInvite(false)}>Done</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Connect Remote Runner Dialog */}
      <Dialog open={showConnect} onOpenChange={(open) => { setShowConnect(open); if (!open) { setNewApiKey(null); setConnectCopied(false); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Connect Remote Runner</DialogTitle></DialogHeader>
          {newApiKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Run this on the remote machine. The command embeds a fresh API key — any previously-connected runner for this agent has been invalidated.
              </p>
              <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all select-all max-h-48 overflow-y-auto">
                {(() => {
                  if (!agent || !newApiKey) return "";
                  const base = typeof window !== "undefined" ? window.location.origin : "";
                  const payload = { url: base, agentId: agent.id, apiKey: newApiKey, name: agent.name, cli: agent.cli, model: agent.model, thinking: agent.thinking, eager: !!agent.eager };
                  const blob = typeof window !== "undefined" ? btoa(JSON.stringify(payload)) : "";
                  return `harbour agent connect ${blob}`;
                })()}
              </div>
              <p className="text-xs text-muted-foreground">
                Workflow gate scripts used by this agent&apos;s jobs must exist at <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.harbour/workflows/</code> on the remote machine.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => {
                  if (!agent || !newApiKey) return;
                  const base = typeof window !== "undefined" ? window.location.origin : "";
                  const payload = { url: base, agentId: agent.id, apiKey: newApiKey, name: agent.name, cli: agent.cli, model: agent.model, thinking: agent.thinking, eager: !!agent.eager };
                  const blob = btoa(JSON.stringify(payload));
                  navigator.clipboard.writeText(`harbour agent connect ${blob}`);
                  setConnectCopied(true);
                  setTimeout(() => setConnectCopied(false), 2000);
                }}>
                  {connectCopied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Command</>}
                </Button>
                <Button onClick={() => { setShowConnect(false); setNewApiKey(null); }}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Generate a connect command for this remote agent. This rotates the API key — any previously-connected runner will stop working until you reconnect it with the new command.
              </p>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowConnect(false)}>Cancel</Button>
                <Button onClick={handleRotateKey}>Generate Command</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
