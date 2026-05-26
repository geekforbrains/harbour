"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SchedulePicker, parseSchedule, serializeSchedule } from "@/components/app/schedule-picker";
import { ModelThinkingSelect, SELECT_CLASS } from "@/components/app/model-thinking-select";
import { AlertCircle, Bot, Pin, FileText, KeyRound, Loader2, Paperclip, Plus, Terminal, X } from "lucide-react";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { uploadFileToRun } from "@/lib/upload-client";

type Agent = { id: string; name: string; type: string; cli: string | null; model: string | null; thinking: string | null; remote: number | null; eager: number | null };
type Doc = { id: string; title: string; pinned: number };
type EnvVar = { id: string; name: string; pinned: number };

// Sub-dialog for picking docs or env vars
export function PickerDialog({
  open,
  onOpenChange,
  title,
  items,
  selectedIds,
  onToggle,
  icon: Icon,
  nameClass,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: { id: string; name: string; pinned: number }[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  icon: React.ComponentType<{ className?: string }>;
  nameClass?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">None available yet.</p>
        ) : (
          <div className="space-y-0.5 max-h-80 overflow-y-auto">
            {items.map(item => (
              <label
                key={item.id}
                className="flex items-center gap-3 rounded-lg p-2.5 cursor-pointer hover:bg-accent/50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => onToggle(item.id)}
                  className="rounded"
                />
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className={`text-sm font-medium flex-1 min-w-0 truncate ${nameClass || ""}`}>{item.name}</span>
                {item.pinned === 1 && <Pin className="h-3 w-3 text-muted-foreground/50 shrink-0" />}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Compact display of selected items with remove buttons
export function SelectedItems({
  items,
  selectedIds,
  onRemove,
  onAdd,
  icon: Icon,
  label,
  emptyText = "None selected. Pinned items auto-included.",
  nameClass,
}: {
  items: { id: string; name: string; pinned: number }[];
  selectedIds: string[];
  onRemove: (id: string) => void;
  onAdd: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  emptyText?: string;
  nameClass?: string;
}) {
  const selected = items.filter(i => selectedIds.includes(i.id));

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <button type="button" onClick={onAdd} className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors">
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-1.5">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {selected.map(item => (
            <span key={item.id} className="inline-flex items-center gap-1 rounded-md bg-background border px-2 py-1 text-xs font-medium">
              <Icon className="h-3 w-3 text-muted-foreground" />
              <span className={nameClass}>{item.name}</span>
              <button type="button" onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-foreground transition-colors ml-0.5">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CreateDialog({
  open,
  onOpenChange,
  defaultTab = "run",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "run" | "job";
}) {
  const queryClient = useQueryClient();
  const activeProjectId = useActiveProjectId();

  const [tab, setTab] = useState<"run" | "job">(defaultTab);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Shared fields
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [selectedEnvVarIds, setSelectedEnvVarIds] = useState<string[]>([]);

  // Picker dialogs
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showEnvVarPicker, setShowEnvVarPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Run-only fields
  const [whenType, setWhenType] = useState<"now" | "later">("now");
  const [scheduledTime, setScheduledTime] = useState("");
  const [stagedFiles, setStagedFiles] = useState<{ file: File; error?: string }[]>([]);
  const stagedFilesRef = useRef<File[]>([]);
  const runFileInputRef = useRef<HTMLInputElement>(null);

  const { data: uploadConfig } = useQuery<{ max_upload_mb: number; max_upload_bytes: number }>({
    queryKey: ["upload-config"],
    queryFn: async () => (await fetch("/api/system/upload-config")).json(),
    staleTime: 60_000,
  });

  // Job-only fields
  const [description, setDescription] = useState("");
  const [schedule, setSchedule] = useState(parseSchedule(null));
  const [workflowCommand, setWorkflowCommand] = useState("");
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [workflowEnabled, setWorkflowEnabled] = useState(false);
  const [titleFormat, setTitleFormat] = useState("");

  useEffect(() => {
    if (open) setTab(defaultTab);
  }, [open, defaultTab]);

  // Load data + auto-select pinned items when dialog opens
  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const [agentsRes, docsRes, envVarsRes] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/docs"),
        fetch("/api/env-vars"),
      ]);
      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgents(data);
        if (data.length > 0 && !agentId) setAgentId(data[0].id);
      }
      if (docsRes.ok) {
        const docsData = await docsRes.json();
        setDocs(docsData);
        setSelectedDocIds(docsData.filter((d: Doc) => d.pinned).map((d: Doc) => d.id));
      }
      if (envVarsRes.ok) {
        const evData = await envVarsRes.json();
        setEnvVars(evData);
        setSelectedEnvVarIds(evData.filter((ev: EnvVar) => ev.pinned).map((ev: EnvVar) => ev.id));
      }
      setLoaded(true);
    })();
  }, [open, loaded, agentId]);

  function reset() {
    setName("");
    setInstructions("");
    setModel("");
    setThinking("");
    setSelectedDocIds([]);
    setSelectedEnvVarIds([]);
    setWhenType("now");
    setScheduledTime("");
    setStagedFiles([]);
    stagedFilesRef.current = [];
    setSubmitting(false);
    setDescription("");
    setSchedule(parseSchedule(null));
    setWorkflowCommand("");
    setAgentEnabled(true);
    setWorkflowEnabled(false);
    setTitleFormat("");
    setLoaded(false);
  }

  function handleClose(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  function toggleItem(id: string, list: string[], setList: (v: string[]) => void) {
    setList(list.includes(id) ? list.filter(i => i !== id) : [...list, id]);
  }

  async function handleCreateRun(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !agentId || submitting) return;
    setSubmitting(true);

    const body: Record<string, unknown> = {
      agentId,
      name,
      instructions: instructions || undefined,
    };
    if (selectedDocIds.length > 0) body.docIds = selectedDocIds;
    if (selectedEnvVarIds.length > 0) body.envVarIds = selectedEnvVarIds;
    if (whenType === "later" && scheduledTime) {
      body.runAt = Math.floor(new Date(scheduledTime).getTime() / 1000);
    }

    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { alert("Failed to create run"); setSubmitting(false); return; }

    const data = await res.json();

    // Upload staged files and link to an activity entry
    const filesToUpload = stagedFilesRef.current;
    if (filesToUpload.length > 0) {
      const attachmentIds: string[] = [];
      const errors: string[] = [];
      for (const file of filesToUpload) {
        try {
          const att = await uploadFileToRun(data.runId, file).promise;
          attachmentIds.push(att.id);
        } catch (err: any) {
          errors.push(`${file.name}: ${err.message || "upload failed"}`);
        }
      }
      if (errors.length > 0) {
        alert(`Some files failed to upload:\n${errors.join("\n")}`);
      }
      if (attachmentIds.length > 0) {
        await fetch(`/api/runs/${data.runId}/activity`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "", attachment_ids: attachmentIds }),
        });
      }
    }

    // Auto-link the backing job to the active project
    if (activeProjectId && data.jobId) {
      await fetch(`/api/projects/${activeProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link", type: "job", targetId: data.jobId }),
      });
    }

    setSubmitting(false);
    handleClose(false);
    queryClient.invalidateQueries({ queryKey: ["runs"] });
  }

  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    const isWorkflowOnly = workflowEnabled && !agentEnabled;
    if (!name.trim() || (!isWorkflowOnly && !agentId)) return;

    const url = isWorkflowOnly ? "/api/jobs" : `/api/agents/${agentId}/jobs`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description || undefined,
        instructions: agentEnabled ? (instructions || undefined) : undefined,
        schedule: serializeSchedule(schedule),
        workflowCommand: workflowEnabled && workflowCommand ? workflowCommand : undefined,
        workflowOnly: isWorkflowOnly ? true : undefined,
        model: agentEnabled ? (model || undefined) : undefined,
        thinking: agentEnabled ? (thinking || undefined) : undefined,
        titleFormat: agentEnabled ? (titleFormat.trim() || undefined) : undefined,
        docIds: selectedDocIds.length > 0 ? selectedDocIds : undefined,
        envVarIds: selectedEnvVarIds.length > 0 ? selectedEnvVarIds : undefined,
      }),
    });
    if (!res.ok) { alert("Failed to create job"); return; }

    // Auto-link the job to the active project
    if (activeProjectId) {
      const data = await res.json();
      if (data.id) {
        await fetch(`/api/projects/${activeProjectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "link", type: "job", targetId: data.id }),
        });
      }
    }

    handleClose(false);
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }

  function handleAgentChange(id: string) {
    setAgentId(id);
    setModel("");
    setThinking("");
    setAgentEnabled(true);
    setWorkflowEnabled(false);
    setWorkflowCommand("");
  }

  const selectedAgent = agents.find(a => a.id === agentId);
  const isHarbourAgent = selectedAgent?.type === "harbour";

  // Shared form fields rendered in both tabs
  const sharedFields = (
    <>
      <div className="space-y-2">
        <Label>Agent</Label>
        <select value={agentId} onChange={e => handleAgentChange(e.target.value)} className={SELECT_CLASS}>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
    </>
  );

  const modelThinkingFields = selectedAgent?.type === "harbour" && selectedAgent.cli ? (
    <div className="grid grid-cols-2 gap-3">
      <ModelThinkingSelect
        cli={selectedAgent.cli}
        model={model}
        thinking={thinking}
        onModelChange={setModel}
        onThinkingChange={setThinking}
        defaultModelLabel={`Default${selectedAgent.model ? ` (${selectedAgent.model})` : ""}`}
        defaultThinkingLabel={`Default${selectedAgent.thinking ? ` (${selectedAgent.thinking})` : ""}`}
      />
    </div>
  ) : null;

  const docsEnvVarsFields = (
    <>
      <SelectedItems
        items={docs.map(d => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={selectedDocIds}
        onRemove={id => setSelectedDocIds(prev => prev.filter(i => i !== id))}
        onAdd={() => setShowDocPicker(true)}
        icon={FileText}
        label="Docs"
      />
      <SelectedItems
        items={envVars}
        selectedIds={selectedEnvVarIds}
        onRemove={id => setSelectedEnvVarIds(prev => prev.filter(i => i !== id))}
        onAdd={() => setShowEnvVarPicker(true)}
        icon={KeyRound}
        label="Env Vars"
        nameClass="font-mono"
      />
    </>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Job</DialogTitle>
          </DialogHeader>

          <Tabs value={tab} onValueChange={v => setTab(v as "run" | "job")}>
            {/* Run/Job switcher hidden — one-off runs are no longer surfaced in the UI.
                The Run tab plumbing is retained so it can be re-enabled later. */}
            <TabsList className="w-full hidden">
              <TabsTrigger value="run" className="flex-1">Run</TabsTrigger>
              <TabsTrigger value="job" className="flex-1">Job</TabsTrigger>
            </TabsList>

            {/* --- Run tab --- */}
            <TabsContent value="run">
              <form onSubmit={handleCreateRun} className="space-y-4 pt-2">
                {sharedFields}

                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Research competitors" required />
                </div>

                <div className="space-y-2">
                  <Label>Instructions</Label>
                  <Textarea value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="What should the agent do?" rows={3} className="max-h-[25vh]" />
                </div>

                {modelThinkingFields}
                {docsEnvVarsFields}

                <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                      <Paperclip className="h-3.5 w-3.5" />
                      Attachments
                    </div>
                    <button type="button" onClick={() => runFileInputRef.current?.click()} className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors cursor-pointer">
                      <Plus className="h-3 w-3" /> Add
                    </button>
                  </div>
                  {stagedFiles.length === 0 ? (
                    <p className="text-xs text-muted-foreground mt-1.5">No files attached.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {stagedFiles.map((entry, i) => (
                        <span key={i} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${entry.error ? "bg-destructive/10 border border-destructive/30" : "bg-background border"}`}>
                          {entry.error ? <AlertCircle className="h-3 w-3 text-destructive" /> : <Paperclip className="h-3 w-3 text-muted-foreground" />}
                          <span className="truncate max-w-[150px]">{entry.file.name}</span>
                          {entry.error && <span className="text-destructive text-[10px]">{entry.error}</span>}
                          <button type="button" onClick={() => setStagedFiles(prev => { const next = prev.filter((_, j) => j !== i); stagedFilesRef.current = next.filter(e => !e.error).map(e => e.file); return next; })} className="text-muted-foreground hover:text-foreground transition-colors ml-0.5">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>When</Label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setWhenType("now")} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${whenType === "now" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>Now</button>
                    <button type="button" onClick={() => setWhenType("later")} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${whenType === "later" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>Schedule</button>
                  </div>
                  {whenType === "later" && (
                    <Input type="datetime-local" value={scheduledTime} onChange={e => setScheduledTime(e.target.value)} required />
                  )}
                </div>

                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>Cancel</Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    {submitting && stagedFilesRef.current.length > 0 ? "Uploading..." : "Create Run"}
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>

            {/* --- Job tab --- */}
            <TabsContent value="job">
              <form onSubmit={handleCreateJob} className="space-y-4 pt-2">
                {agentEnabled && sharedFields}

                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Morning Tweet" required />
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description" />
                </div>

                {(isHarbourAgent || !agentEnabled) && (
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { if (!agentEnabled || workflowEnabled) setAgentEnabled(!agentEnabled); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${agentEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Bot className="h-3.5 w-3.5" />Agent</button>
                      <button type="button" onClick={() => { if (!workflowEnabled || agentEnabled) setWorkflowEnabled(!workflowEnabled); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${workflowEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Terminal className="h-3.5 w-3.5" />Workflow</button>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Schedule</Label>
                  <SchedulePicker schedule={schedule} onChange={setSchedule} />
                </div>

                {workflowEnabled && (
                  <div className="space-y-2">
                    <Label>Workflow Command</Label>
                    <Input value={workflowCommand} onChange={e => setWorkflowCommand(e.target.value)} placeholder="e.g. python3 check_prs.py" className="font-mono text-xs" required />
                    <p className="text-xs text-muted-foreground">
                      Exit 0 = success, 77 = skip, other = fail.
                      {selectedAgent?.remote ? (
                        <> Script must exist at <code className="text-[11px] bg-muted px-1 py-0.5 rounded">~/.harbour/workflows/</code> on the remote machine running this agent.</>
                      ) : null}
                    </p>
                  </div>
                )}

                {agentEnabled && (
                  <>
                    <div className="space-y-2">
                      <Label>Instructions</Label>
                      <Textarea value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="What should the agent do?" rows={3} className="max-h-[25vh]" />
                    </div>
                    <div className="space-y-2">
                      <Label>Title Format</Label>
                      <Input
                        value={titleFormat}
                        onChange={e => setTitleFormat(e.target.value)}
                        placeholder={`e.g. "Issue #XXX — short summary"`}
                      />
                      <p className="text-xs text-muted-foreground">Optional. Each run sets its own title — this is the format guide passed to the agent.</p>
                    </div>
                    {modelThinkingFields}
                  </>
                )}

                {docsEnvVarsFields}

                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => handleClose(false)}>Cancel</Button>
                  <Button type="submit">Create Job</Button>
                </DialogFooter>
              </form>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* File input rendered outside the dialog portal for Safari compatibility */}
      <input
        ref={runFileInputRef}
        type="file"
        multiple
        style={{ position: "fixed", top: -100, left: -100, opacity: 0 }}
        onChange={e => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          if (files.length > 0) {
            const maxBytes = uploadConfig?.max_upload_bytes;
            const maxMb = uploadConfig?.max_upload_mb;
            const entries = files.map(f => ({
              file: f,
              error: maxBytes && f.size > maxBytes ? `Exceeds ${maxMb} MB limit` : undefined,
            }));
            setStagedFiles(prev => {
              const next = [...prev, ...entries];
              stagedFilesRef.current = next.filter(e => !e.error).map(e => e.file);
              return next;
            });
          }
          e.target.value = "";
        }}
      />

      {/* Sub-dialogs for picking docs and env vars */}
      <PickerDialog
        open={showDocPicker}
        onOpenChange={setShowDocPicker}
        title="Select Docs"
        items={docs.map(d => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={new Set(selectedDocIds)}
        onToggle={id => toggleItem(id, selectedDocIds, setSelectedDocIds)}
        icon={FileText}
      />
      <PickerDialog
        open={showEnvVarPicker}
        onOpenChange={setShowEnvVarPicker}
        title="Select Env Vars"
        items={envVars}
        selectedIds={new Set(selectedEnvVarIds)}
        onToggle={id => toggleItem(id, selectedEnvVarIds, setSelectedEnvVarIds)}
        icon={KeyRound}
        nameClass="font-mono"
      />
    </>
  );
}
