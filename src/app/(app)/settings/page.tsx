"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Trash2, Plus, Copy, Check, Cpu, MemoryStick, Activity, Zap, Bot, Layers, RefreshCw } from "lucide-react";
import { useApp } from "@/components/app/app-context";
import { useRouter } from "next/navigation";
import { CLI_CONFIG } from "@/lib/cli-config";
import { ModelThinkingSelect, SELECT_CLASS } from "@/components/app/model-thinking-select";

type Settings = Record<string, string>;

type VideoCheck = {
  ffmpeg: boolean;
  whisper: boolean;
  openai: { available: boolean; reason?: string };
  gemini: { available: boolean; reason?: string };
} | null;

type Metrics = {
  timestamp: number;
  runs: { running: number; pending: number; done24h: number; failed24h: number };
  agents: number;
  jobs: number;
  system: {
    cpuPct: number;
    cpuCores: number;
    loadAvg1m: number;
    memUsedMb: number;
    memTotalMb: number;
    memPct: number;
    uptimeHours: number;
    platform: string;
  };
  freellm: { enabled: boolean; baseUrl: string; online: boolean; modelCount: number };
};

type Tab = "general" | "captain" | "usage";

// ── Metric bar helper ──────────────────────────────────────────────────────────
function MetricBar({ pct, color = "bg-primary" }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, warn }: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; warn?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 space-y-1 ${warn ? "border-amber-500/30 bg-amber-500/5" : ""}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Usage tab ─────────────────────────────────────────────────────────────────
function UsageTab({ settings, updateSetting }: { settings: Settings; updateSetting: (k: string, v: string) => Promise<void> }) {
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const { data: metrics, isFetching } = useQuery<Metrics>({
    queryKey: ["metrics", lastRefresh],
    queryFn: async () => {
      const res = await fetch("/api/metrics");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 0,
  });

  // Auto-refresh every 10s
  useEffect(() => {
    const id = setInterval(() => setLastRefresh(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  const freellmEnabled = settings.freellm_enabled === "true";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-base font-medium">System Usage</Label>
          <p className="text-xs text-muted-foreground mt-0.5">Live metrics — auto-refreshes every 10 seconds.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setLastRefresh(Date.now())} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Agent & Run stats */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Agent Activity</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Running" value={metrics?.runs.running ?? "–"} icon={Activity}
            warn={(metrics?.runs.running ?? 0) > 0} sub="active runs" />
          <StatCard label="Queued" value={metrics?.runs.pending ?? "–"} icon={Layers} sub="pending runs" />
          <StatCard label="Done (24h)" value={metrics?.runs.done24h ?? "–"} icon={Check} sub="completed" />
          <StatCard label="Agents" value={metrics?.agents ?? "–"} icon={Bot} sub={`${metrics?.jobs ?? 0} active jobs`} />
        </div>
      </div>

      {/* System metrics */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">System Resources</p>
        {metrics?.system ? (
          <div className="rounded-lg border p-4 space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground"><Cpu className="h-3.5 w-3.5" /> CPU</span>
                <span className="tabular-nums font-medium">{metrics.system.cpuPct}%</span>
              </div>
              <MetricBar pct={metrics.system.cpuPct} color={metrics.system.cpuPct > 80 ? "bg-red-500" : metrics.system.cpuPct > 60 ? "bg-amber-500" : "bg-primary"} />
              <p className="text-xs text-muted-foreground">{metrics.system.cpuCores} cores · load avg {metrics.system.loadAvg1m}</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground"><MemoryStick className="h-3.5 w-3.5" /> RAM</span>
                <span className="tabular-nums font-medium">{metrics.system.memPct}%</span>
              </div>
              <MetricBar pct={metrics.system.memPct} color={metrics.system.memPct > 85 ? "bg-red-500" : metrics.system.memPct > 70 ? "bg-amber-500" : "bg-primary"} />
              <p className="text-xs text-muted-foreground">{metrics.system.memUsedMb.toLocaleString()} MB used of {metrics.system.memTotalMb.toLocaleString()} MB · uptime {metrics.system.uptimeHours}h</p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading system metrics...</div>
        )}
      </div>

      {/* FreeLLM status */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">FreeLLM Router</p>
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Use free models first</p>
              <p className="text-xs text-muted-foreground mt-0.5">Routes requests through FreeLLM before hitting paid APIs.</p>
            </div>
            <button
              onClick={() => updateSetting("freellm_enabled", freellmEnabled ? "false" : "true")}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${freellmEnabled ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${freellmEnabled ? "translate-x-5.5 ml-0.5" : "translate-x-0.5"}`} />
            </button>
          </div>
          {metrics && (
            <div className="flex flex-wrap gap-3 text-xs pt-1 border-t">
              <span className="flex items-center gap-1">
                <span className={`h-1.5 w-1.5 rounded-full ${metrics.freellm.online ? "bg-green-500" : "bg-muted-foreground"}`} />
                {metrics.freellm.online ? "Online" : "Offline"}
              </span>
              {metrics.freellm.online && (
                <span className="text-muted-foreground">{metrics.freellm.modelCount} free models available</span>
              )}
              <span className="text-muted-foreground font-mono">{metrics.freellm.baseUrl}</span>
            </div>
          )}
          {!metrics?.freellm.online && freellmEnabled && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Server appears offline. Start it: <code className="font-mono">bash &quot;/Users/davidk/Documents/Borg Interface/harbour/freellmapi/start.sh&quot;</code>
            </p>
          )}
        </div>
      </div>

      {/* Placeholder: Token burn tracking */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Token Tracking</p>
        <div className="rounded-lg border border-dashed p-4 text-center space-y-1">
          <Zap className="h-5 w-5 mx-auto text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">Per-run token tracking coming soon.</p>
          <p className="text-xs text-muted-foreground/70">Harbour will log token consumption per Captain session and agent run once provider SDKs expose usage headers.</p>
        </div>
      </div>
    </div>
  );
}

// ── VideoProcessingSettings (unchanged) ───────────────────────────────────────
function VideoProcessingSettings({ settings, updateSetting }: { settings: Settings; updateSetting: (key: string, value: string) => Promise<void> }) {
  const queryClient = useQueryClient();
  const autoProcess = settings.video_auto_process === "true";
  const interval = settings.video_screenshot_interval || "5";
  const provider = settings.video_transcript_provider || "off";

  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  const { data: videoCheck } = useQuery<VideoCheck>({
    queryKey: ["video-processing-check"],
    queryFn: async () => {
      const res = await fetch("/api/settings/video-processing/check");
      if (!res.ok) return null;
      return res.json();
    },
  });

  const maskedKey = provider === "openai"
    ? settings.video_openai_api_key || ""
    : provider === "gemini"
    ? settings.video_gemini_api_key || ""
    : "";

  const displayKey = apiKeyDirty ? apiKey : maskedKey;
  const settingKey = provider === "openai" ? "video_openai_api_key" : "video_gemini_api_key";

  async function saveApiKey() {
    if (!apiKeyDirty || !apiKey.trim()) { setApiKeyDirty(false); return; }
    await updateSetting(settingKey, apiKey.trim());
    setApiKey("");
    setApiKeyDirty(false);
    queryClient.invalidateQueries({ queryKey: ["video-processing-check"] });
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div>
        <Label className="text-base font-medium">Video Processing</Label>
        <p className="text-xs text-muted-foreground mt-0.5">Automatically extract screenshots and transcripts from uploaded videos.</p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>Auto-process videos</Label>
          <p className="text-xs text-muted-foreground mt-0.5">When enabled, uploaded videos are processed automatically.</p>
        </div>
        <button
          onClick={() => updateSetting("video_auto_process", autoProcess ? "false" : "true")}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${autoProcess ? "bg-primary" : "bg-muted"}`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${autoProcess ? "translate-x-5.5 ml-0.5" : "translate-x-0.5"}`} />
        </button>
      </div>
      <div className="space-y-2">
        <Label>Screenshot interval (seconds)</Label>
        <Input type="number" min={1} className="font-mono text-sm w-32" value={interval}
          onChange={e => { const v = parseInt(e.target.value, 10); if (v > 0) updateSetting("video_screenshot_interval", String(v)); }} />
      </div>
      <div className="space-y-2">
        <Label>Transcript provider</Label>
        <select value={provider}
          onChange={e => { updateSetting("video_transcript_provider", e.target.value); setApiKey(""); setApiKeyDirty(false); }}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <option value="off">Off</option>
          <option value="whisper">Whisper (local)</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>
      {videoCheck && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className={videoCheck.ffmpeg ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
            ffmpeg: {videoCheck.ffmpeg ? "✓ detected" : "✗ not found"}
          </span>
          {provider === "whisper" && <span className={videoCheck.whisper ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>whisper: {videoCheck.whisper ? "✓ detected" : "✗ not found"}</span>}
          {provider === "openai" && <span className={videoCheck.openai.available ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>OpenAI: {videoCheck.openai.available ? "✓ ready" : `✗ ${videoCheck.openai.reason || "not available"}`}</span>}
          {provider === "gemini" && <span className={videoCheck.gemini.available ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>Gemini: {videoCheck.gemini.available ? "✓ ready" : `✗ ${videoCheck.gemini.reason || "not available"}`}</span>}
        </div>
      )}
      {(provider === "openai" || provider === "gemini") && (
        <div className="space-y-2">
          <Label>{provider === "openai" ? "OpenAI API Key" : "Gemini API Key"}</Label>
          <Input type="text" className="font-mono text-sm" placeholder={provider === "openai" ? "sk-..." : "AI..."}
            value={displayKey} onChange={e => { setApiKey(e.target.value); setApiKeyDirty(true); }}
            onBlur={saveApiKey} onKeyDown={e => { if (e.key === "Enter") saveApiKey(); }} />
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { projects, activeProjectId, setActiveProjectId } = useApp();
  const activeProject = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;

  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [tzSearch, setTzSearch] = useState("");
  const [tzOpen, setTzOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectNameLoaded, setProjectNameLoaded] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [newKeyName, setNewKeyName] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (activeProject && (!projectNameLoaded || projectName === "")) {
    setProjectName(activeProject.name);
    setProjectNameLoaded(true);
  }
  if (!activeProject && projectNameLoaded) setProjectNameLoaded(false);

  async function handleRenameProject() {
    if (!activeProjectId || !projectName.trim() || projectName === activeProject?.name) return;
    await fetch(`/api/projects/${activeProjectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName.trim() }),
    });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  }

  async function handleDeleteProject() {
    if (!activeProjectId) return;
    setDeleting(true);
    await fetch(`/api/projects/${activeProjectId}`, { method: "DELETE" });
    setActiveProjectId(null);
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    setShowDeleteConfirm(false);
    setDeleting(false);
    router.push("/");
  }

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return {};
      return res.json();
    },
  });

  const { data: timezones = [] } = useQuery<string[]>({
    queryKey: ["timezones"],
    queryFn: async () => {
      const res = await fetch("/api/settings/timezones");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: adminKeys = [] } = useQuery<any[]>({
    queryKey: ["admin-api-keys"],
    queryFn: async () => {
      const res = await fetch("/api/admin-api-keys");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createKeyMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/admin-api-keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to create key");
      return res.json();
    },
    onSuccess: (data) => {
      setCreatedKey(data.apiKey);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] });
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: async (id: string) => { await fetch(`/api/admin-api-keys/${id}`, { method: "DELETE" }); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin-api-keys"] }); },
  });

  const filteredTimezones = useMemo(() => {
    if (!tzSearch) return timezones;
    const lower = tzSearch.toLowerCase();
    return timezones.filter(tz => tz.toLowerCase().includes(lower));
  }, [timezones, tzSearch]);

  const updateSetting = useCallback(async (key: string, value: string) => {
    const res = await fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    if (!res.ok) { alert("Failed to update setting"); return; }
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  }, [queryClient]);

  if (isLoading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  const timezone = settings?.timezone || "";
  const signupEnabled = settings?.signup_enabled !== "false";
  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "captain", label: "Captain" },
    { id: "usage", label: "Usage" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">System-wide configuration.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b pb-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px border-b-2 ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── General tab ── */}
      {activeTab === "general" && (
        <div className="space-y-6 max-w-lg">
          {activeProject && (
            <div className="rounded-lg border p-4 space-y-4">
              <div>
                <Label className="text-base font-medium">Project</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Manage the current project.</p>
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={projectName} onChange={e => setProjectName(e.target.value)}
                  onBlur={handleRenameProject} onKeyDown={e => { if (e.key === "Enter") handleRenameProject(); }}
                  className="text-sm" />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <div>
                  <p className="text-sm font-medium">Delete project</p>
                  <p className="text-xs text-muted-foreground">Removes the project and all links. Agents, jobs, docs, and env vars are not deleted.</p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Timezone</Label>
            <p className="text-xs text-muted-foreground">Used for scheduling jobs and displaying times.</p>
            <div className="relative">
              <Input value={tzOpen ? tzSearch : timezone}
                onChange={e => { setTzSearch(e.target.value); setTzOpen(true); }}
                onFocus={() => { setTzSearch(""); setTzOpen(true); }}
                onBlur={() => setTimeout(() => setTzOpen(false), 200)}
                placeholder="Search timezones..." className="font-mono text-sm" />
              {tzOpen && filteredTimezones.length > 0 && (
                <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border bg-popover shadow-md">
                  {filteredTimezones.slice(0, 50).map(tz => (
                    <button key={tz} type="button" onMouseDown={e => e.preventDefault()}
                      onClick={() => { updateSetting("timezone", tz); setTzOpen(false); setTzSearch(""); }}
                      className={`w-full text-left px-3 py-2 text-sm font-mono hover:bg-accent transition-colors ${tz === timezone ? "bg-accent/50 font-medium" : ""}`}>
                      {tz}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Recent Runs Shown</Label>
            <p className="text-xs text-muted-foreground">Number of completed runs to display on the main Runs page.</p>
            <Input type="number" min={1} className="font-mono text-sm w-32" value={settings?.recent_runs_limit || "10"}
              onChange={e => { const v = parseInt(e.target.value, 10); if (v > 0) updateSetting("recent_runs_limit", String(v)); }} />
          </div>

          <VideoProcessingSettings settings={settings || {}} updateSetting={updateSetting} />

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <Label>Allow Signup</Label>
              <p className="text-xs text-muted-foreground mt-0.5">When disabled, new users cannot register.</p>
            </div>
            <button onClick={() => updateSetting("signup_enabled", signupEnabled ? "false" : "true")}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${signupEnabled ? "bg-primary" : "bg-muted"}`}>
              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${signupEnabled ? "translate-x-5.5 ml-0.5" : "translate-x-0.5"}`} />
            </button>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <Label className="text-base font-medium">Admin API Keys</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Keys for external agents to manage Harbour. Each key has full admin access.</p>
            </div>
            {adminKeys.length > 0 && (
              <div className="space-y-2">
                {adminKeys.map((key: any) => (
                  <div key={key.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{key.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Created {new Date(key.created_at * 1000).toLocaleDateString()}
                        {key.last_used_at && <> &middot; Last used {new Date(key.last_used_at * 1000).toLocaleDateString()}</>}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => deleteKeyMutation.mutate(key.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowNewKey(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> New Key
            </Button>
          </div>
        </div>
      )}

      {/* ── Captain tab ── */}
      {activeTab === "captain" && (
        <div className="space-y-6 max-w-lg">
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <Label className="text-base font-medium">Captain</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Chat with a CLI tool directly from the dashboard.</p>
            </div>
            <div className="space-y-2">
              <Label>CLI Tool</Label>
              <select value={settings?.captain_cli || "claude"}
                onChange={e => updateSetting("captain_cli", e.target.value)} className={SELECT_CLASS}>
                {Object.keys(CLI_CONFIG).map(cli => (
                  <option key={cli} value={cli}>{cli.charAt(0).toUpperCase() + cli.slice(1)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {settings?.captain_cli === "pi" && "Pi routes to Groq, Ollama, or any configured provider — great for free/cheap inference."}
                {settings?.captain_cli === "opencode" && "OpenCode supports 40+ providers via OpenRouter, Ollama, Anthropic, and more."}
                {(!settings?.captain_cli || settings?.captain_cli === "claude") && "Claude CLI — requires ANTHROPIC_API_KEY."}
                {settings?.captain_cli === "codex" && "OpenAI Codex — requires OPENAI_API_KEY."}
                {settings?.captain_cli === "gemini" && "Gemini CLI — requires GEMINI_API_KEY."}
              </p>
            </div>
            <ModelThinkingSelect
              cli={settings?.captain_cli || "claude"}
              model={settings?.captain_model || ""}
              thinking={settings?.captain_thinking || ""}
              onModelChange={v => updateSetting("captain_model", v)}
              onThinkingChange={v => updateSetting("captain_thinking", v)}
              defaultModelLabel="Default"
              defaultThinkingLabel="Default"
            />
            <div className="space-y-2">
              <Label>Working Directory</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Where the CLI tool runs. Point this at a project repo for file access.</p>
              <Input placeholder="~/.harbour/captain" className="font-mono text-sm"
                value={settings?.captain_cwd || ""}
                onChange={e => { if (!e.target.value.trim()) updateSetting("captain_cwd", ""); }}
                onBlur={e => updateSetting("captain_cwd", e.target.value.trim())}
                onKeyDown={e => { if (e.key === "Enter") updateSetting("captain_cwd", (e.target as HTMLInputElement).value.trim()); }} />
            </div>
          </div>

          {/* FreeLLM routing config in Captain tab */}
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <Label className="text-base font-medium">FreeLLM Router</Label>
              <p className="text-xs text-muted-foreground mt-0.5">OpenAI-compatible proxy aggregating 11 free providers (Groq, Gemini, Cerebras, SambaNova, Mistral, Cloudflare, Cohere…). Routes to cheapest available before hitting paid APIs.</p>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Enable free routing</Label>
                <p className="text-xs text-muted-foreground mt-0.5">When enabled, FreeLLM is tried first for all Captain requests.</p>
              </div>
              <button onClick={() => updateSetting("freellm_enabled", settings?.freellm_enabled === "true" ? "false" : "true")}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${settings?.freellm_enabled === "true" ? "bg-primary" : "bg-muted"}`}>
                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${settings?.freellm_enabled === "true" ? "translate-x-5.5 ml-0.5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2 font-mono">
              <p>Base URL: {settings?.freellm_base_url || "http://localhost:3001/v1"}</p>
              <p>Start: <span className="text-foreground">bash &quot;/Users/davidk/Documents/Borg Interface/harbour/freellmapi/start.sh&quot;</span></p>
              <p>Model routing: <span className="text-foreground">model: &quot;auto&quot;</span> lets router pick best free model</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Usage tab ── */}
      {activeTab === "usage" && (
        <div className="max-w-2xl">
          <UsageTab settings={settings || {}} updateSetting={updateSetting} />
        </div>
      )}

      {/* Dialogs (shared across all tabs) */}
      <Dialog open={showNewKey} onOpenChange={(open) => { setShowNewKey(open); if (!open) setNewKeyName(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Admin API Key</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Give this key a name to identify which agent or integration uses it.</p>
            <Input placeholder="e.g. Claude Code assistant" value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && newKeyName.trim()) { createKeyMutation.mutate(newKeyName.trim()); setShowNewKey(false); } }} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewKey(false)}>Cancel</Button>
            <Button disabled={!newKeyName.trim() || createKeyMutation.isPending}
              onClick={() => { createKeyMutation.mutate(newKeyName.trim()); setShowNewKey(false); }}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!createdKey} onOpenChange={(open) => { if (!open) { setCreatedKey(null); setCopied(false); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Admin API Key Created</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Copy this invite and paste it into your management agent. The key won&apos;t be shown again.</p>
            <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all select-all max-h-64 overflow-y-auto">
              {`You have admin access to a Harbour instance — a control plane for AI agents.\n\nSave these credentials now:\n- Admin API Key: ${createdKey}\n- Base URL: ${typeof window !== "undefined" ? window.location.origin : ""}\n\nTo get started, fetch the admin guide:\n  GET ${typeof window !== "undefined" ? window.location.origin : ""}/api/admin-guide\n  Authorization: Bearer ${createdKey}\n\nThe guide covers every endpoint you can use to manage agents, jobs, runs, docs, databases, env vars, projects, and settings.`}
            </div>
            <Button variant="outline" className="w-full" onClick={() => {
              const base = typeof window !== "undefined" ? window.location.origin : "";
              navigator.clipboard.writeText(`You have admin access to a Harbour instance — a control plane for AI agents.\n\nSave these credentials now:\n- Admin API Key: ${createdKey}\n- Base URL: ${base}\n\nTo get started, fetch the admin guide:\n  GET ${base}/api/admin-guide\n  Authorization: Bearer ${createdKey}\n\nThe guide covers every endpoint you can use to manage agents, jobs, runs, docs, databases, env vars, projects, and settings.`);
              setCopied(true);
            }}>
              {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy Invite</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete {activeProject?.name}?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will remove the project and all its links. Your agents, jobs, docs, and env vars will not be deleted.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteProject} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete Project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
