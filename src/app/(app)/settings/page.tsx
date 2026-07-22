"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { PageHeader, PageLoading } from "@/components/app/page-header";
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
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import {
  type MintedRunner,
  useCreateRunner,
  useDeleteRunner,
  useRunners,
} from "@/lib/hooks/use-runners";
import { timeAgo } from "@/lib/time";

type Settings = Record<string, string>;

type ApiKey = {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { projects, activeProjectId, setActiveProjectId, timezone } = useApp();
  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;

  const [tzSearch, setTzSearch] = useState("");
  const [tzOpen, setTzOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectNameLoaded, setProjectNameLoaded] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // API keys
  const [newKeyName, setNewKeyName] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Runners
  const [showNewRunner, setShowNewRunner] = useState(false);
  const [newRunnerName, setNewRunnerName] = useState("");
  const [newRunnerLabels, setNewRunnerLabels] = useState("");
  const [mintedRunner, setMintedRunner] = useState<MintedRunner | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);

  // Sync project name when active project changes
  if (activeProject && (!projectNameLoaded || projectName === "")) {
    setProjectName(activeProject.name);
    setProjectNameLoaded(true);
    setRenameError(null);
  }
  if (!activeProject && projectNameLoaded) {
    setProjectNameLoaded(false);
  }

  async function handleRenameProject() {
    if (!activeProjectId || !projectName.trim() || projectName === activeProject?.name) return;
    setRenameError(null);
    try {
      await apiFetch(`/api/projects/${activeProjectId}`, {
        method: "PUT",
        body: { name: projectName.trim() },
      });
    } catch (err) {
      setRenameError(mutationErrorMessage(err, "Failed to rename project"));
      return;
    }
    queryClient.invalidateQueries({ queryKey: qk.projects.all });
  }

  async function handleDeleteProject() {
    if (!activeProjectId) return;
    setDeleting(true);
    await apiFetch(`/api/projects/${activeProjectId}`, { method: "DELETE" });
    setActiveProjectId(null);
    queryClient.invalidateQueries({ queryKey: qk.projects.all });
    setShowDeleteConfirm(false);
    setDeleting(false);
    router.push("/");
  }

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: qk.settings.detail(),
    queryFn: () => apiFetch<Settings>("/api/settings").catch(() => ({})),
  });

  const { data: timezones = [] } = useQuery<string[]>({
    queryKey: qk.settings.timezones(),
    queryFn: () => apiFetch<string[]>("/api/settings/timezones").catch(() => []),
  });

  const { data: apiKeys = [] } = useQuery<ApiKey[]>({
    queryKey: qk.apiKeys.list(),
    queryFn: () => apiFetch<ApiKey[]>("/api/api-keys").catch(() => []),
  });

  const createKeyMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ apiKey: string }>("/api/api-keys", {
        method: "POST",
        body: { name },
      }),
    onSuccess: (data) => {
      setCreatedKey(data.apiKey);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
  });

  const { data: runners = [] } = useRunners();
  const createRunner = useCreateRunner();
  const deleteRunner = useDeleteRunner();

  function parseLabels(raw: string): string[] {
    return raw
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function submitNewRunner() {
    const name = newRunnerName.trim();
    if (!name || createRunner.isPending) return;
    createRunner.mutate(
      { name, labels: parseLabels(newRunnerLabels) },
      {
        onSuccess: (data) => {
          setMintedRunner(data);
          setShowNewRunner(false);
          setNewRunnerName("");
          setNewRunnerLabels("");
        },
      },
    );
  }

  const filteredTimezones = useMemo(() => {
    if (!tzSearch) return timezones;
    const lower = tzSearch.toLowerCase();
    return timezones.filter((tz) => tz.toLowerCase().includes(lower));
  }, [timezones, tzSearch]);

  async function updateSetting(key: string, value: string) {
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: { [key]: value },
      });
    } catch {
      alert("Failed to update setting");
      return;
    }
    queryClient.invalidateQueries({ queryKey: qk.settings.all });
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const keyInvite = `You have full access to a Harbour instance — a control plane for AI agents.\n\nSave these credentials now:\n- API Key: ${createdKey}\n- Base URL: ${origin}\n\nTo get started, fetch the management guide:\n  GET ${origin}/api/management-guide\n  Authorization: Bearer ${createdKey}\n\nThe guide covers every endpoint you can use to manage agents, jobs, runs, docs, tables, env vars, projects, and settings.`;

  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="System-wide configuration." />

      <div className="space-y-6 max-w-lg">
        {/* Project Settings */}
        {activeProject && (
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <Label className="text-base font-medium">Project</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Manage the current project.</p>
            </div>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onBlur={handleRenameProject}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameProject();
                }}
                className="text-sm"
              />
              {renameError && <p className="text-xs text-destructive">{renameError}</p>}
            </div>
            <div className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <div>
                <p className="text-sm font-medium">Delete project</p>
                <p className="text-xs text-muted-foreground">
                  Permanently deletes this project and everything in it — agents, jobs, runs, docs,
                  secrets, and tables. This cannot be undone.
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
                <Trash2 className="h-4 w-4 mr-1.5" /> Delete
              </Button>
            </div>
          </div>
        )}

        {/* Timezone */}
        <div className="space-y-2">
          <Label>Timezone</Label>
          <p className="text-xs text-muted-foreground">
            Used for scheduling jobs and displaying times.
          </p>
          <div className="relative">
            <Input
              value={tzOpen ? tzSearch : timezone}
              onChange={(e) => {
                setTzSearch(e.target.value);
                setTzOpen(true);
              }}
              onFocus={() => {
                setTzSearch("");
                setTzOpen(true);
              }}
              onBlur={() => setTimeout(() => setTzOpen(false), 200)}
              placeholder="Search timezones..."
              className="font-mono text-sm"
            />
            {tzOpen && filteredTimezones.length > 0 && (
              <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border bg-popover shadow-md">
                {filteredTimezones.slice(0, 50).map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      updateSetting("timezone", tz);
                      setTzOpen(false);
                      setTzSearch("");
                    }}
                    className={`w-full text-left px-3 py-2 text-sm font-mono hover:bg-accent transition-colors ${tz === timezone ? "bg-accent/50 font-medium" : ""}`}
                  >
                    {tz}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Runs Limit */}
        <div className="space-y-2">
          <Label>Recent Runs Shown</Label>
          <p className="text-xs text-muted-foreground">
            Number of completed runs to display on the main Runs page.
          </p>
          <Input
            type="number"
            min={1}
            className="font-mono text-sm w-32"
            value={settings?.recent_runs_limit || "10"}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v > 0) updateSetting("recent_runs_limit", String(v));
            }}
          />
        </div>

        {/* Per-job cap on successes in the Recent feed */}
        <div className="space-y-2">
          <Label>Successes Per Job</Label>
          <p className="text-xs text-muted-foreground">
            Max successful runs each job shows in the Recent feed, so a chatty job can&apos;t bury
            everything else. Failures always show individually; skipped runs are hidden.
          </p>
          <Input
            type="number"
            min={1}
            className="font-mono text-sm w-32"
            value={settings?.recent_runs_per_job || "3"}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v > 0) updateSetting("recent_runs_per_job", String(v));
            }}
          />
        </div>

        {/* API Keys */}
        <div className="rounded-lg border p-4 space-y-4">
          <div>
            <Label className="text-base font-medium">API Keys</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Keys for external agents to manage Harbour. Each key has full access.
            </p>
          </div>
          {apiKeys.length > 0 && (
            <div className="space-y-2">
              {apiKeys.map((key) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{key.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(key.created_at * 1000).toLocaleDateString()}
                      {key.last_used_at && (
                        <>
                          {" "}
                          &middot; Last used{" "}
                          {new Date(key.last_used_at * 1000).toLocaleDateString()}
                        </>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-8 w-8"
                    onClick={() => deleteKeyMutation.mutate(key.id)}
                  >
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

        {/* Runners */}
        <div className="rounded-lg border p-4 space-y-4">
          <div>
            <Label className="text-base font-medium">Runners</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Hosts that claim and execute runs. Local runners are the auto-provisioned pool; remote
              runners are operator-minted for other machines.
            </p>
          </div>
          {runners.length > 0 && (
            <div className="space-y-2">
              {runners.map((runner) => (
                <div
                  key={runner.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{runner.name}</p>
                      <Badge variant="outline">{runner.tier}</Badge>
                    </div>
                    {runner.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {runner.labels.map((label) => (
                          <Badge key={label} variant="secondary" className="font-mono">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {runner.capabilities && runner.capabilities.clis.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-muted-foreground">CLIs:</span>
                        {runner.capabilities.clis.map((cli) => (
                          <Badge key={cli} variant="outline" className="font-mono">
                            {cli}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {runner.capabilities && runner.capabilities.kinds.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Kinds: {runner.capabilities.kinds.join(", ")}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground">
                        Last polled {timeAgo(runner.last_polled_at)}
                      </p>
                      {(runner.running_count ?? 0) > 0 && (
                        <Badge variant="secondary">{runner.running_count} running</Badge>
                      )}
                    </div>
                  </div>
                  {runner.tier === "remote" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-8 w-8"
                      disabled={deleteRunner.isPending}
                      onClick={() => deleteRunner.mutate(runner.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowNewRunner(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New Runner
          </Button>
        </div>
      </div>

      {/* Create API key dialog */}
      <Dialog
        open={showNewKey}
        onOpenChange={(open) => {
          setShowNewKey(open);
          if (!open) setNewKeyName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Give this key a name to identify which agent or integration uses it.
            </p>
            <Input
              placeholder="e.g. Claude Code assistant"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newKeyName.trim()) {
                  createKeyMutation.mutate(newKeyName.trim());
                  setShowNewKey(false);
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewKey(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newKeyName.trim() || createKeyMutation.isPending}
              onClick={() => {
                createKeyMutation.mutate(newKeyName.trim());
                setShowNewKey(false);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show created key dialog */}
      <Dialog
        open={!!createdKey}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Copy this invite and paste it into your management agent. The key won&apos;t be shown
              again.
            </p>
            <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all select-all max-h-64 overflow-y-auto">
              {keyInvite}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                navigator.clipboard.writeText(keyInvite);
                setCopied(true);
              }}
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-1.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-1.5" /> Copy Invite
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create runner dialog */}
      <Dialog
        open={showNewRunner}
        onOpenChange={(open) => {
          setShowNewRunner(open);
          if (!open) {
            setNewRunnerName("");
            setNewRunnerLabels("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Runner</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Mint a credential for a runner on another machine. Enroll it there with{" "}
              <code className="font-mono">npm run harbour-agent -- connect &lt;blob&gt;</code>.
            </p>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. build-box"
                value={newRunnerName}
                onChange={(e) => setNewRunnerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewRunner();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Labels</Label>
              <Input
                placeholder="e.g. gpu, us-east"
                value={newRunnerLabels}
                onChange={(e) => setNewRunnerLabels(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewRunner();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated placement labels this runner serves. Agents and workflows routed to
                a matching label run here.
              </p>
            </div>
            {createRunner.isError && (
              <p className="text-xs text-destructive">
                {mutationErrorMessage(createRunner.error, "Failed to create runner")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewRunner(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newRunnerName.trim() || createRunner.isPending}
              onClick={submitNewRunner}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show minted runner connect command dialog */}
      <Dialog
        open={!!mintedRunner}
        onOpenChange={(open) => {
          if (!open) {
            setMintedRunner(null);
            setConnectCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Runner Created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Run this on the runner host to enroll it. The credential won&apos;t be shown again.
            </p>
            <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all select-all max-h-64 overflow-y-auto">
              {mintedRunner?.connect}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                if (mintedRunner) navigator.clipboard.writeText(mintedRunner.connect);
                setConnectCopied(true);
              }}
            >
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
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showDeleteConfirm}
        onOpenChange={(open) => {
          setShowDeleteConfirm(open);
          if (!open) setDeleteConfirmText("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {activeProject?.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently deletes the project and everything in it — agents, jobs, runs, docs,
            secrets, and tables. This cannot be undone.
          </p>
          <div className="space-y-2">
            <Label htmlFor="delete-project-confirm">
              Type <span className="font-mono font-medium">{activeProject?.name}</span> to confirm
            </Label>
            <Input
              id="delete-project-confirm"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={activeProject?.name}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowDeleteConfirm(false);
                setDeleteConfirmText("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteProject}
              disabled={deleting || deleteConfirmText !== activeProject?.name}
            >
              {deleting ? "Deleting..." : "Delete Project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
