"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SchedulePicker, parseSchedule, serializeSchedule } from "@/components/app/schedule-picker";
import { ModelThinkingSelect, SELECT_CLASS } from "@/components/app/model-thinking-select";
import { Bot, Pin, FileText, KeyRound, Plus, Terminal, X } from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import { useDocs } from "@/lib/hooks/use-docs";
import { useEnvVars } from "@/lib/hooks/use-env-vars";
import { useCreateAgentJob, useCreateWorkflowJob } from "@/lib/hooks/use-jobs";

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

/**
 * New Job dialog. v2 removed one-off "New Run" creation — ad-hoc runs now come
 * from triggering a scheduled job (see TriggerDialog / RunRow). This dialog
 * creates either an agent job (POST /api/agents/:id/jobs) or a workflow-only
 * job (POST /api/jobs).
 */
export function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Retained for call-site compatibility; the dialog only creates jobs now. */
  defaultTab?: "run" | "job";
}) {
  const createAgentJob = useCreateAgentJob();
  const createWorkflowJob = useCreateWorkflowJob();

  // Scoped lists from the data layer (loaded while the dialog is open).
  const { data: agents = [] } = useAgents(undefined, { enabled: open });
  const { data: docs = [] } = useDocs(undefined, { enabled: open });
  const { data: envVars = [] } = useEnvVars(undefined, { enabled: open });

  // Shared fields
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [selectedEnvVarIds, setSelectedEnvVarIds] = useState<string[]>([]);
  const [pinnedSeeded, setPinnedSeeded] = useState(false);

  // Picker dialogs
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showEnvVarPicker, setShowEnvVarPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Job fields
  const [description, setDescription] = useState("");
  const [schedule, setSchedule] = useState(parseSchedule(null));
  const [workflowCommand, setWorkflowCommand] = useState("");
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [workflowEnabled, setWorkflowEnabled] = useState(false);
  const [titleFormat, setTitleFormat] = useState("");

  // Default the agent select to the first agent once the list loads.
  useEffect(() => {
    if (open && agents.length > 0 && !agentId) setAgentId(agents[0].id);
  }, [open, agents, agentId]);

  // Auto-select pinned docs/env vars once when the dialog opens.
  useEffect(() => {
    if (!open || pinnedSeeded) return;
    if (docs.length === 0 && envVars.length === 0) return;
    setSelectedDocIds(docs.filter((d) => d.pinned).map((d) => d.id));
    setSelectedEnvVarIds(envVars.filter((ev) => ev.pinned).map((ev) => ev.id));
    setPinnedSeeded(true);
  }, [open, pinnedSeeded, docs, envVars]);

  function reset() {
    setName("");
    setInstructions("");
    setModel("");
    setThinking("");
    setSelectedDocIds([]);
    setSelectedEnvVarIds([]);
    setPinnedSeeded(false);
    setSubmitting(false);
    setDescription("");
    setSchedule(parseSchedule(null));
    setWorkflowCommand("");
    setAgentEnabled(true);
    setWorkflowEnabled(false);
    setTitleFormat("");
  }

  function handleClose(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  function toggleItem(id: string, list: string[], setList: (v: string[]) => void) {
    setList(list.includes(id) ? list.filter(i => i !== id) : [...list, id]);
  }

  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    const isWorkflowOnly = workflowEnabled && !agentEnabled;
    if (!name.trim() || (!isWorkflowOnly && !agentId) || submitting) return;
    setSubmitting(true);

    const body = {
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
    };

    try {
      // Workflow jobs are created in the active project (scoped POST); agent
      // jobs inherit their agent's project. v2 has no separate link step.
      if (isWorkflowOnly) {
        await createWorkflowJob.mutateAsync(body);
      } else {
        await createAgentJob.mutateAsync({ agentId, body });
      }
      handleClose(false);
    } catch {
      alert("Failed to create job");
    } finally {
      setSubmitting(false);
    }
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

  const sharedFields = (
    <div className="space-y-2">
      <Label>Agent</Label>
      <select value={agentId} onChange={e => handleAgentChange(e.target.value)} className={SELECT_CLASS}>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </div>
  );

  const modelThinkingFields = selectedAgent?.cli ? (
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
        items={docs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={selectedDocIds}
        onRemove={id => setSelectedDocIds(prev => prev.filter(i => i !== id))}
        onAdd={() => setShowDocPicker(true)}
        icon={FileText}
        label="Docs"
      />
      <SelectedItems
        items={envVars.map((ev) => ({ id: ev.id, name: ev.name, pinned: ev.pinned }))}
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

            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                <button type="button" onClick={() => { if (!agentEnabled || workflowEnabled) setAgentEnabled(!agentEnabled); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${agentEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Bot className="h-3.5 w-3.5" />Agent</button>
                <button type="button" onClick={() => { if (!workflowEnabled || agentEnabled) setWorkflowEnabled(!workflowEnabled); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${workflowEnabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}><Terminal className="h-3.5 w-3.5" />Workflow</button>
              </div>
            </div>

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
              <Button type="button" variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>Cancel</Button>
              <Button type="submit" disabled={submitting}>{submitting ? "Creating..." : "Create Job"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sub-dialogs for picking docs and env vars */}
      <PickerDialog
        open={showDocPicker}
        onOpenChange={setShowDocPicker}
        title="Select Docs"
        items={docs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={new Set(selectedDocIds)}
        onToggle={id => toggleItem(id, selectedDocIds, setSelectedDocIds)}
        icon={FileText}
      />
      <PickerDialog
        open={showEnvVarPicker}
        onOpenChange={setShowEnvVarPicker}
        title="Select Env Vars"
        items={envVars.map((ev) => ({ id: ev.id, name: ev.name, pinned: ev.pinned }))}
        selectedIds={new Set(selectedEnvVarIds)}
        onToggle={id => toggleItem(id, selectedEnvVarIds, setSelectedEnvVarIds)}
        icon={KeyRound}
        nameClass="font-mono"
      />
    </>
  );
}
