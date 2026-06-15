"use client";

import { FileText, KeyRound, Pin, Plus, Table2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { GateField } from "@/components/app/gate-field";
import { ModelThinkingSelect, SELECT_CLASS } from "@/components/app/model-thinking-select";
import { parseSchedule, SchedulePicker, serializeSchedule } from "@/components/app/schedule-picker";
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
import { ApiError } from "@/lib/api/client";
import { useAgents } from "@/lib/hooks/use-agents";
import { useDocs } from "@/lib/hooks/use-docs";
import { useEnvVars } from "@/lib/hooks/use-env-vars";
import { useCreateAgentJob, useCreateWorkflowJob } from "@/lib/hooks/use-jobs";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useTables } from "@/lib/hooks/use-tables";
import type { Gate } from "@/lib/runtimes";

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
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">None available yet.</p>
        ) : (
          <div className="space-y-0.5 max-h-80 overflow-y-auto">
            {items.map((item) => (
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
                <span className={`text-sm font-medium flex-1 min-w-0 truncate ${nameClass || ""}`}>
                  {item.name}
                </span>
                {item.pinned === 1 && <Pin className="h-3 w-3 text-muted-foreground/50 shrink-0" />}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
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
  const selected = items.filter((i) => selectedIds.includes(i.id));

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-1.5">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {selected.map((item) => (
            <span
              key={item.id}
              className="inline-flex items-center gap-1 rounded-md bg-background border px-2 py-1 text-xs font-medium"
            >
              <Icon className="h-3 w-3 text-muted-foreground" />
              <span className={nameClass}>{item.name}</span>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="text-muted-foreground hover:text-foreground transition-colors ml-0.5"
              >
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
 * New Job / New Workflow dialog. v2 removed one-off "New Run" creation —
 * ad-hoc runs now come from triggering a scheduled job (see TriggerDialog /
 * RunRow). The `kind` prop fixes what gets created: an agent job
 * (POST /api/agents/:id/jobs) or a workflow job (POST /api/jobs).
 */
export function CreateDialog({
  open,
  onOpenChange,
  kind = "agent",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: "agent" | "workflow";
}) {
  const createAgentJob = useCreateAgentJob();
  const createWorkflowJob = useCreateWorkflowJob();
  const activeProjectId = useActiveProjectId();

  // Scoped lists from the data layer (loaded while the dialog is open).
  const { data: agents = [] } = useAgents(undefined, { enabled: open });
  const { data: docs = [] } = useDocs(undefined, { enabled: open });
  const { data: envVars = [] } = useEnvVars(undefined, { enabled: open });
  const { data: tables = [] } = useTables(undefined, { enabled: open });

  // Shared fields
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [selectedEnvVarIds, setSelectedEnvVarIds] = useState<string[]>([]);
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([]);
  const [pinnedSeeded, setPinnedSeeded] = useState(false);

  // Picker dialogs
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showEnvVarPicker, setShowEnvVarPicker] = useState(false);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Job fields. Gates (prerun/postrun for agents, the command for workflows)
  // are gist-style { runtime, content } scripts, null until set.
  const [description, setDescription] = useState("");
  const [schedule, setSchedule] = useState(parseSchedule(null));
  const [workflowGate, setWorkflowGate] = useState<Gate | null>(null);
  const [prerun, setPrerun] = useState<Gate | null>(null);
  const [postrun, setPostrun] = useState<Gate | null>(null);
  const [postrunGates, setPostrunGates] = useState(false);
  const [titleFormat, setTitleFormat] = useState("");
  // Workflow-only: scope is fixed at creation. Agent jobs are always project-level.
  const [workflowScope, setWorkflowScope] = useState<"project" | "org">("project");

  // Without an active project, "This project" isn't an option — force org level.
  const orgScoped = kind === "workflow" && (workflowScope === "org" || !activeProjectId);
  // An org-level workflow may link only org-level resources (project_id IS NULL);
  // the server rejects anything wider with a 400.
  const eligibleDocs = orgScoped ? docs.filter((d) => d.project_id === null) : docs;
  const eligibleEnvVars = orgScoped ? envVars.filter((ev) => ev.project_id === null) : envVars;
  const eligibleTables = orgScoped ? tables.filter((t) => t.project_id === null) : tables;

  // Default the agent select to the first agent once the list loads.
  useEffect(() => {
    if (open && agents.length > 0 && !agentId) setAgentId(agents[0].id);
  }, [open, agents, agentId]);

  // Auto-select pinned docs/env vars/tables once when the dialog opens.
  useEffect(() => {
    if (!open || pinnedSeeded) return;
    if (docs.length === 0 && envVars.length === 0 && tables.length === 0) return;
    setSelectedDocIds(docs.filter((d) => d.pinned).map((d) => d.id));
    setSelectedEnvVarIds(envVars.filter((ev) => ev.pinned).map((ev) => ev.id));
    setSelectedTableIds(tables.filter((t) => t.pinned).map((t) => t.id));
    setPinnedSeeded(true);
  }, [open, pinnedSeeded, docs, envVars, tables]);

  function reset() {
    setName("");
    setInstructions("");
    setModel("");
    setThinking("");
    setSelectedDocIds([]);
    setSelectedEnvVarIds([]);
    setSelectedTableIds([]);
    setPinnedSeeded(false);
    setSubmitting(false);
    setDescription("");
    setSchedule(parseSchedule(null));
    setWorkflowGate(null);
    setPrerun(null);
    setPostrun(null);
    setPostrunGates(false);
    setTitleFormat("");
    setWorkflowScope("project");
  }

  function handleClose(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  function toggleItem(id: string, list: string[], setList: (v: string[]) => void) {
    setList(list.includes(id) ? list.filter((i) => i !== id) : [...list, id]);
  }

  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    const isWorkflow = kind === "workflow";
    if (!name.trim() || (!isWorkflow && !agentId) || (isWorkflow && !workflowGate) || submitting)
      return;
    setSubmitting(true);

    // Drop selections that aren't linkable in the chosen scope (e.g. pinned
    // project-level docs auto-seeded before the user picked "Entire org").
    const docIds = selectedDocIds.filter((sid) => eligibleDocs.some((d) => d.id === sid));
    const envVarIds = selectedEnvVarIds.filter((sid) =>
      eligibleEnvVars.some((ev) => ev.id === sid),
    );
    const tableIds = selectedTableIds.filter((sid) => eligibleTables.some((t) => t.id === sid));

    const body = {
      name,
      description: description || undefined,
      instructions: !isWorkflow ? instructions || undefined : undefined,
      schedule: serializeSchedule(schedule),
      command: isWorkflow ? (workflowGate ?? undefined) : undefined,
      prerun: !isWorkflow ? (prerun ?? undefined) : undefined,
      postrun: !isWorkflow ? (postrun ?? undefined) : undefined,
      postrunGates: !isWorkflow && postrun ? postrunGates : undefined,
      model: !isWorkflow ? model || undefined : undefined,
      thinking: !isWorkflow ? thinking || undefined : undefined,
      titleFormat: !isWorkflow ? titleFormat.trim() || undefined : undefined,
      docIds: docIds.length > 0 ? docIds : undefined,
      envVarIds: envVarIds.length > 0 ? envVarIds : undefined,
      tableIds: tableIds.length > 0 ? tableIds : undefined,
    };

    try {
      // Workflow jobs are created at the chosen scope (active project, or the
      // whole org); agent jobs inherit their agent's project. v2 has no
      // separate link step.
      if (isWorkflow) {
        await createWorkflowJob.mutateAsync({ body, orgLevel: orgScoped });
      } else {
        await createAgentJob.mutateAsync({ agentId, body });
      }
      handleClose(false);
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  }

  function handleAgentChange(id: string) {
    setAgentId(id);
    setModel("");
    setThinking("");
    setPrerun(null);
  }

  const selectedAgent = agents.find((a) => a.id === agentId);

  const sharedFields = (
    <div className="space-y-2">
      <Label>Agent</Label>
      <select
        value={agentId}
        onChange={(e) => handleAgentChange(e.target.value)}
        className={SELECT_CLASS}
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
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
        items={eligibleDocs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={selectedDocIds}
        onRemove={(id) => setSelectedDocIds((prev) => prev.filter((i) => i !== id))}
        onAdd={() => setShowDocPicker(true)}
        icon={FileText}
        label="Docs"
      />
      <SelectedItems
        items={eligibleEnvVars.map((ev) => ({ id: ev.id, name: ev.name, pinned: ev.pinned }))}
        selectedIds={selectedEnvVarIds}
        onRemove={(id) => setSelectedEnvVarIds((prev) => prev.filter((i) => i !== id))}
        onAdd={() => setShowEnvVarPicker(true)}
        icon={KeyRound}
        label="Secrets"
        nameClass="font-mono"
      />
      <SelectedItems
        items={eligibleTables.map((t) => ({ id: t.id, name: t.name, pinned: t.pinned }))}
        selectedIds={selectedTableIds}
        onRemove={(id) => setSelectedTableIds((prev) => prev.filter((i) => i !== id))}
        onAdd={() => setShowTablePicker(true)}
        icon={Table2}
        label="Tables"
        nameClass="font-mono"
      />
    </>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{kind === "workflow" ? "New Workflow" : "New Job"}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleCreateJob} className="space-y-4 pt-2">
            {kind === "agent" && sharedFields}

            {kind === "workflow" && (
              <div className="space-y-2">
                <Label>Scope</Label>
                <select
                  value={orgScoped ? "org" : "project"}
                  onChange={(e) => setWorkflowScope(e.target.value === "org" ? "org" : "project")}
                  className={SELECT_CLASS}
                >
                  <option value="project" disabled={!activeProjectId}>
                    This project
                  </option>
                  <option value="org">Entire org</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Fixed at creation. Org workflows can link only org-level docs and secrets.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Morning Tweet"
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description"
              />
            </div>

            <div className="space-y-2">
              <Label>Schedule</Label>
              <SchedulePicker schedule={schedule} onChange={setSchedule} />
            </div>

            {kind === "workflow" && (
              <GateField
                label="Command"
                value={workflowGate}
                onChange={setWorkflowGate}
                required
                description="The script this workflow runs. Pick a runtime and write the body."
                placeholder={
                  "#!/usr/bin/env bash\nset -euo pipefail\n# do the work, exit 77 to skip"
                }
              />
            )}

            {kind === "agent" && (
              <>
                <div className="space-y-2">
                  <Label>Instructions</Label>
                  <Textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="What should the agent do?"
                    rows={3}
                    className="max-h-[25vh]"
                  />
                </div>
                <GateField
                  label="Prerun"
                  value={prerun}
                  onChange={setPrerun}
                  description="Optional gate before the LLM. Exit 0 continues, 77 skips, other fails."
                  placeholder={"#!/usr/bin/env bash\n# exit 77 if there's no work for the agent"}
                />
                <div className="space-y-2">
                  <GateField
                    label="Postrun"
                    value={postrun}
                    onChange={(g) => {
                      setPostrun(g);
                      if (!g) setPostrunGates(false);
                    }}
                    description="Optional hook after the run finishes. Receives the run payload on stdin."
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={postrunGates}
                      onClick={() => setPostrunGates((v) => !v)}
                      disabled={!postrun}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 ${postrunGates ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {postrunGates ? "Enforcing" : "Informational"}
                    </button>
                    <span className="text-xs text-muted-foreground">
                      {postrunGates
                        ? "Nonzero exit overrides done → failed."
                        : "Runs on any outcome; never changes status."}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Title Format</Label>
                  <Input
                    value={titleFormat}
                    onChange={(e) => setTitleFormat(e.target.value)}
                    placeholder={`e.g. "Issue #XXX — short summary"`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Each run sets its own title — this is the format guide passed to the
                    agent.
                  </p>
                </div>
                {modelThinkingFields}
              </>
            )}

            {docsEnvVarsFields}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleClose(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting
                  ? "Creating..."
                  : kind === "workflow"
                    ? "Create Workflow"
                    : "Create Job"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sub-dialogs for picking docs, env vars, and tables */}
      <PickerDialog
        open={showDocPicker}
        onOpenChange={setShowDocPicker}
        title="Select Docs"
        items={eligibleDocs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={new Set(selectedDocIds)}
        onToggle={(id) => toggleItem(id, selectedDocIds, setSelectedDocIds)}
        icon={FileText}
      />
      <PickerDialog
        open={showEnvVarPicker}
        onOpenChange={setShowEnvVarPicker}
        title="Select Secrets"
        items={eligibleEnvVars.map((ev) => ({ id: ev.id, name: ev.name, pinned: ev.pinned }))}
        selectedIds={new Set(selectedEnvVarIds)}
        onToggle={(id) => toggleItem(id, selectedEnvVarIds, setSelectedEnvVarIds)}
        icon={KeyRound}
        nameClass="font-mono"
      />
      <PickerDialog
        open={showTablePicker}
        onOpenChange={setShowTablePicker}
        title="Select Tables"
        items={eligibleTables.map((t) => ({ id: t.id, name: t.name, pinned: t.pinned }))}
        selectedIds={new Set(selectedTableIds)}
        onToggle={(id) => toggleItem(id, selectedTableIds, setSelectedTableIds)}
        icon={Table2}
        nameClass="font-mono"
      />
    </>
  );
}
