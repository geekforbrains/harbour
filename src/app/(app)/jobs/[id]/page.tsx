"use client";

import {
  Calendar,
  CalendarClock,
  Cpu,
  Database,
  FileText,
  KeyRound,
  Pause,
  Pin,
  Play,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { BackLink } from "@/components/app/back-link";
import { PickerDialog, SelectedItems } from "@/components/app/create-dialog";
import { EmptyState } from "@/components/app/empty-state";
import { GateField } from "@/components/app/gate-field";
import { ModelThinkingSelect } from "@/components/app/model-thinking-select";
import { OrgBadge } from "@/components/app/org-badge";
import { PageLoading } from "@/components/app/page-header";
import { RowLink } from "@/components/app/row-link";
import { StatusDot } from "@/components/app/run-status";
import {
  formatSchedule,
  parseSchedule,
  SchedulePicker,
  serializeSchedule,
} from "@/components/app/schedule-picker";
import { SectionHeader } from "@/components/app/section-header";
import { TriggerDialog } from "@/components/app/trigger-dialog";
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
import { ApiError } from "@/lib/api/client";
import { useAgent } from "@/lib/hooks/use-agents";
import { useDocs } from "@/lib/hooks/use-docs";
import { useEnvVars } from "@/lib/hooks/use-env-vars";
import {
  useDeleteJob,
  useJob,
  useJobLinkMutations,
  useJobRuns,
  useUpdateJob,
} from "@/lib/hooks/use-jobs";
import { DEFAULT_RUNTIME, type Gate, isRuntime, RUNTIME_META } from "@/lib/runtimes";
import { formatTimestamp, timeAgo } from "@/lib/time";

type Job = {
  id: string;
  kind: "agent" | "workflow";
  org_id: string;
  /** null = org-level workflow (agent jobs are always project-level). */
  project_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_color: string | null;
  name: string;
  description: string | null;
  instructions: string | null;
  schedule: string;
  prerun_runtime: string | null;
  prerun_script: string | null;
  postrun_runtime: string | null;
  postrun_script: string | null;
  postrun_gates: number;
  workflow_runtime: string | null;
  workflow_script: string | null;
  timeout_minutes: number;
  model: string | null;
  thinking: string | null;
  title_format: string | null;
  active: number;
  last_run_at: number | null;
  next_run_at: number | null;
  docs: { id: string; title: string }[];
  databases: { id: string; name: string; table_name: string }[];
  envVars: { id: string; name: string }[];
};
const INSTRUCTIONS_CHAR_LIMIT = 400;

/** Rebuild a gate from a job's stored runtime+script columns, null when unset. */
function toGate(runtime: string | null, script: string | null): Gate | null {
  if (!script) return null;
  return { runtime: isRuntime(runtime) ? runtime : DEFAULT_RUNTIME, content: script };
}

function InstructionsBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > INSTRUCTIONS_CHAR_LIMIT;
  const displayed =
    needsTruncation && !expanded ? `${text.slice(0, INSTRUCTIONS_CHAR_LIMIT).trimEnd()}…` : text;

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">Instructions</p>
      <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border p-4 bg-card text-sm whitespace-pre-wrap break-words overflow-hidden">
        {displayed}
      </div>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { timezone } = useApp();

  const { data: jobData, isLoading: loading } = useJob(id);
  const job = (jobData as Job | undefined) ?? null;

  const { data: agentData } = useAgent(job?.agent_id ?? "", { enabled: !!job?.agent_id });
  const agent =
    (agentData as
      | { type?: string; cli?: string | null; model?: string | null; thinking?: string | null }
      | undefined) ?? null;

  const { data: jobRunsData = [] } = useJobRuns(id);

  const { data: allDocs = [] } = useDocs();
  const { data: allEnvVars = [] } = useEnvVars();

  const updateJob = useUpdateJob();
  const deleteJob = useDeleteJob();
  const linkMutations = useJobLinkMutations(id);

  const specificRuns = Array.isArray(jobRunsData) ? jobRunsData : [];

  const [showEdit, setShowEdit] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editSchedule, setEditSchedule] = useState(parseSchedule(null));
  // Gates: workflow command (workflow jobs), prerun + postrun (agent jobs).
  const [editWorkflow, setEditWorkflow] = useState<Gate | null>(null);
  const [editPrerun, setEditPrerun] = useState<Gate | null>(null);
  const [editPostrun, setEditPostrun] = useState<Gate | null>(null);
  const [editPostrunGates, setEditPostrunGates] = useState(false);
  const [editTimeout, setEditTimeout] = useState(30);
  const [editModel, setEditModel] = useState("");
  const [editThinking, setEditThinking] = useState("");
  const [editTitleFormat, setEditTitleFormat] = useState("");
  const [editDocIds, setEditDocIds] = useState<string[]>([]);
  const [editEnvVarIds, setEditEnvVarIds] = useState<string[]>([]);
  const [showEditDocPicker, setShowEditDocPicker] = useState(false);
  const [showEditEnvVarPicker, setShowEditEnvVarPicker] = useState(false);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const editingWorkflow = job?.kind === "workflow";
    try {
      await updateJob.mutateAsync({
        id,
        body: {
          name: editName,
          description: editDesc,
          instructions: editingWorkflow ? "" : editInstructions,
          schedule: serializeSchedule(editSchedule),
          // Gates: workflow sends `command`; agents send prerun/postrun (null
          // clears). command/prerun/postrun are { runtime, content } | null.
          command: editingWorkflow ? editWorkflow : undefined,
          prerun: editingWorkflow ? undefined : editPrerun,
          postrun: editingWorkflow ? undefined : editPostrun,
          postrunGates: editingWorkflow ? undefined : editPostrunGates,
          timeoutMinutes: editTimeout,
          model: editingWorkflow ? "" : editModel || "",
          thinking: editingWorkflow ? "" : editThinking || "",
          titleFormat: editingWorkflow ? "" : editTitleFormat,
          docIds: editDocIds,
          envVarIds: editEnvVarIds,
        },
      });
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed to update job");
      return;
    }
    setShowEdit(false);
  }

  async function handleToggleActive() {
    if (!job) return;
    try {
      await updateJob.mutateAsync({ id, body: { active: !job.active } });
    } catch {
      alert("Failed to update job");
    }
  }

  async function handleLinkDoc(docId: string) {
    try {
      await linkMutations.linkDoc.mutateAsync(docId);
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed to link doc");
    }
  }

  async function handleUnlinkDoc(docId: string) {
    try {
      await linkMutations.unlinkDoc.mutateAsync(docId);
    } catch {
      alert("Failed to unlink doc");
    }
  }

  async function handleLinkEnvVar(envVarId: string) {
    try {
      await linkMutations.linkEnvVar.mutateAsync(envVarId);
    } catch (err) {
      alert(err instanceof ApiError ? err.errorMessage : "Failed to link secret");
    }
  }

  async function handleUnlinkEnvVar(envVarId: string) {
    try {
      await linkMutations.unlinkEnvVar.mutateAsync(envVarId);
    } catch {
      alert("Failed to unlink secret");
    }
  }

  const [showTrigger, setShowTrigger] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete "${job?.name}"? All run history will be lost.`)) return;
    try {
      await deleteJob.mutateAsync(id);
    } catch {
      alert("Failed to delete job");
      return;
    }
    router.push(
      job?.kind === "workflow" ? "/workflows" : job?.agent_id ? `/agents/${job.agent_id}` : "/jobs",
    );
  }

  if (loading) return <PageLoading />;
  if (!job)
    return <div className="text-sm text-muted-foreground py-12 text-center">Job not found.</div>;

  const isWorkflow = job.kind === "workflow";
  const prerunGate = toGate(job.prerun_runtime, job.prerun_script);
  const postrunGate = toGate(job.postrun_runtime, job.postrun_script);
  const workflowGate = toGate(job.workflow_runtime, job.workflow_script);
  // The primary gate shown up top: a workflow's command, or an agent's prerun.
  const primaryGate = isWorkflow ? workflowGate : prerunGate;
  const isOrgLevel = job.project_id === null;
  // Org-level workflows may link only org-level resources; the server 400s
  // anything project-scoped, so don't offer it.
  const linkableDocs = isOrgLevel ? allDocs.filter((d) => d.project_id === null) : allDocs;
  const linkableEnvVars = isOrgLevel
    ? allEnvVars.filter((ev) => ev.project_id === null)
    : allEnvVars;

  return (
    <div className="space-y-6">
      <BackLink
        href={isWorkflow ? "/workflows" : "/jobs"}
        label={isWorkflow ? "Workflows" : "Jobs"}
      />

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{job.name}</h1>
            {isOrgLevel && <OrgBadge />}
            {!job.active && <Badge variant="secondary">Paused</Badge>}
          </div>
          {job.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{job.description}</p>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowTrigger(true)}
            title="Trigger run now"
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={handleToggleActive}
            title={job.active ? "Pause" : "Resume"}
          >
            {job.active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              if (job) {
                setEditName(job.name);
                setEditDesc(job.description || "");
                setEditInstructions(job.instructions || "");
                setEditSchedule(parseSchedule(job.schedule));
                setEditWorkflow(toGate(job.workflow_runtime, job.workflow_script));
                setEditPrerun(toGate(job.prerun_runtime, job.prerun_script));
                setEditPostrun(toGate(job.postrun_runtime, job.postrun_script));
                setEditPostrunGates(!!job.postrun_gates);
                setEditTimeout(job.timeout_minutes ?? 30);
                setEditModel(job.model || "");
                setEditThinking(job.thinking || "");
                setEditTitleFormat(job.title_format || "");
                setEditDocIds(job.docs.map((d) => d.id));
                setEditEnvVarIds(job.envVars.map((ev) => ev.id));
              }
              setShowEdit(true);
            }}
            title="Edit"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-4 rounded-lg border p-3">
        {!isWorkflow ? (
          <div className="flex items-center gap-2 text-sm">
            <span
              className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background"
              style={{ backgroundColor: resolveAgentColor(job.agent_color, job.agent_name) }}
            />
            <Link
              href={`/agents/${job.agent_id}`}
              className="text-muted-foreground hover:text-foreground transition-colors truncate"
            >
              {job.agent_name}
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground truncate">Workflow</span>
          </div>
        )}
        {(job.model || job.thinking) && (
          <div className="flex items-center gap-2 text-sm">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">
              {[job.model, job.thinking].filter(Boolean).join(" · ")}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {formatSchedule(parseSchedule(job.schedule))}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <RotateCcw className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {job.last_run_at ? timeAgo(job.last_run_at) : "No runs yet"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">
            {formatTimestamp(job.next_run_at, timezone) || "—"}
          </span>
        </div>
      </div>

      {!isWorkflow && job.instructions && <InstructionsBlock text={job.instructions} />}

      {primaryGate && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">
              {isWorkflow ? "Workflow" : "Prerun"}
            </p>
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
              {isWorkflow ? "Deterministic" : "Agent Gate"}
            </span>
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground">
              {RUNTIME_META[primaryGate.runtime].label}
            </span>
          </div>
          <code className="block rounded-lg bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words">
            {primaryGate.content}
          </code>
        </div>
      )}

      {!isWorkflow && postrunGate && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Postrun</p>
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
              {job.postrun_gates ? "Enforcing Gate" : "Informational"}
            </span>
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground">
              {RUNTIME_META[postrunGate.runtime].label}
            </span>
          </div>
          <code className="block rounded-lg bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words">
            {postrunGate.content}
          </code>
        </div>
      )}

      {/* Docs */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionHeader>Docs</SectionHeader>
          <Button variant="outline" size="sm" onClick={() => setShowDocs(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>
        {job.docs.length === 0 ? (
          <EmptyState>No docs linked to this job.</EmptyState>
        ) : (
          <div className="space-y-2">
            {job.docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-lg border p-3 group">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <Link
                  href={`/docs/${d.id}`}
                  className="text-sm font-medium flex-1 min-w-0 truncate hover:text-primary transition-colors"
                >
                  {d.title}
                </Link>
                <button
                  type="button"
                  onClick={() => handleUnlinkDoc(d.id)}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0 sm:opacity-0 sm:group-hover:opacity-100"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Databases */}
      {job.databases.length > 0 && (
        <section>
          <SectionHeader>Databases</SectionHeader>
          <div className="space-y-2">
            {job.databases.map((d) => (
              <RowLink key={d.id} href={`/databases/${d.id}`} align="center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Database className="h-4 w-4 text-muted-foreground" />
                </div>
                <span className="text-sm font-mono font-medium">{d.name}</span>
              </RowLink>
            ))}
          </div>
        </section>
      )}

      {/* Secrets */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionHeader>Secrets</SectionHeader>
          <Button variant="outline" size="sm" onClick={() => setShowEnvVars(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>
        {job.envVars.length === 0 ? (
          <EmptyState>No secrets linked to this job.</EmptyState>
        ) : (
          <div className="space-y-2">
            {job.envVars.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-lg border p-3 group">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                </div>
                <Link
                  href={`/env-vars/${ev.id}`}
                  className="text-sm font-mono font-medium flex-1 min-w-0 truncate hover:text-primary transition-colors"
                >
                  {ev.name}
                </Link>
                <button
                  type="button"
                  onClick={() => handleUnlinkEnvVar(ev.id)}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0 sm:opacity-0 sm:group-hover:opacity-100"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Run History */}
      <div className="space-y-3">
        <SectionHeader>Run History</SectionHeader>
        {specificRuns.length === 0 ? (
          <EmptyState>No runs yet.</EmptyState>
        ) : (
          <>
            <div className="space-y-2">
              {specificRuns.map((run) => (
                <RowLink key={run.id} href={`/runs/${run.id}`} align="center">
                  <StatusDot status={run.status} />
                  <span className="text-sm font-medium flex-1 truncate">
                    {run.title || run.status}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {timeAgo(run.completed_at || run.created_at)}
                  </span>
                </RowLink>
              ))}
            </div>
            <div className="text-center pt-1">
              <Link
                href={`/runs?jobId=${id}`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View all runs for this job →
              </Link>
            </div>
          </>
        )}
      </div>

      {/* Add Docs Dialog */}
      <Dialog open={showDocs} onOpenChange={setShowDocs}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Docs</DialogTitle>
          </DialogHeader>
          {(() => {
            const linkedIds = new Set(job.docs.map((d) => d.id));
            const available = linkableDocs.filter((d) => !linkedIds.has(d.id));
            if (available.length === 0) {
              return (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  All docs are already linked to this job.
                </p>
              );
            }
            return (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {available.map((d) => (
                  <button
                    type="button"
                    key={d.id}
                    onClick={async () => {
                      await handleLinkDoc(d.id);
                    }}
                    className="flex items-center gap-3 w-full rounded-lg p-2.5 text-left hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{d.title}</span>
                    {d.pinned === 1 && <Pin className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </button>
                ))}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDocs(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Secrets Dialog */}
      <Dialog open={showEnvVars} onOpenChange={setShowEnvVars}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Secrets</DialogTitle>
          </DialogHeader>
          {(() => {
            const linkedIds = new Set(job.envVars.map((ev) => ev.id));
            const available = linkableEnvVars.filter((ev) => !linkedIds.has(ev.id));
            if (available.length === 0) {
              return (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  All secrets are already linked to this job.
                </p>
              );
            }
            return (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {available.map((ev) => (
                  <button
                    type="button"
                    key={ev.id}
                    onClick={async () => {
                      await handleLinkEnvVar(ev.id);
                    }}
                    className="flex items-center gap-3 w-full rounded-lg p-2.5 text-left hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm font-mono font-medium flex-1 min-w-0 truncate">
                      {ev.name}
                    </span>
                    {ev.pinned === 1 && <Pin className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </button>
                ))}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEnvVars(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>{isWorkflow ? "Edit Workflow" : "Edit Job"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            {!isWorkflow && (
              <>
                <div className="space-y-2">
                  <Label>Instructions</Label>
                  <Textarea
                    value={editInstructions}
                    onChange={(e) => setEditInstructions(e.target.value)}
                    rows={4}
                    className="max-h-[30vh] break-all"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Title Format</Label>
                  <Input
                    value={editTitleFormat}
                    onChange={(e) => setEditTitleFormat(e.target.value)}
                    placeholder={`e.g. "Issue #XXX — short summary"`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Tells the agent how to phrase each run title. Leave blank for a
                    generic short sentence.
                  </p>
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label>Schedule</Label>
              <SchedulePicker schedule={editSchedule} onChange={setEditSchedule} />
            </div>
            {isWorkflow ? (
              <GateField
                label="Command"
                value={editWorkflow}
                onChange={setEditWorkflow}
                required
                description="The script this workflow runs. Exit 0 = done, 77 = skip, other = fail."
              />
            ) : (
              <GateField
                label="Prerun"
                value={editPrerun}
                onChange={setEditPrerun}
                description="Optional gate before the LLM. Exit 0 continues, 77 skips, other fails."
              />
            )}
            {!isWorkflow && (
              <div className="space-y-2">
                <GateField
                  label="Postrun"
                  value={editPostrun}
                  onChange={(g) => {
                    setEditPostrun(g);
                    if (!g) setEditPostrunGates(false);
                  }}
                  description="Optional hook after the run finishes. Receives the run payload on stdin."
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={editPostrunGates}
                    onClick={() => setEditPostrunGates((v) => !v)}
                    disabled={!editPostrun}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 ${editPostrunGates ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                  >
                    {editPostrunGates ? "Enforcing" : "Informational"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {editPostrunGates
                      ? "Nonzero exit overrides done → failed."
                      : "Runs on any outcome; never changes status."}
                  </span>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label>Timeout (minutes)</Label>
              <Input
                type="number"
                min={1}
                value={editTimeout}
                onChange={(e) => setEditTimeout(parseInt(e.target.value, 10) || 30)}
              />
            </div>
            {!isWorkflow && agent?.cli && (
              <ModelThinkingSelect
                cli={agent.cli}
                model={editModel}
                thinking={editThinking}
                onModelChange={setEditModel}
                onThinkingChange={setEditThinking}
                defaultModelLabel={`Agent default${agent.model ? ` (${agent.model})` : ""}`}
                defaultThinkingLabel={`Agent default${agent.thinking ? ` (${agent.thinking})` : ""}`}
              />
            )}
            <SelectedItems
              items={linkableDocs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
              selectedIds={editDocIds}
              onRemove={(did) => setEditDocIds((prev) => prev.filter((i) => i !== did))}
              onAdd={() => setShowEditDocPicker(true)}
              icon={FileText}
              label="Docs"
            />
            <SelectedItems
              items={linkableEnvVars}
              selectedIds={editEnvVarIds}
              onRemove={(evid) => setEditEnvVarIds((prev) => prev.filter((i) => i !== evid))}
              onAdd={() => setShowEditEnvVarPicker(true)}
              icon={KeyRound}
              label="Secrets"
              nameClass="font-mono"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                className="mr-auto"
              >
                <Trash2 className="h-4 w-4 mr-1" /> Delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowEdit(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog sub-pickers */}
      <PickerDialog
        open={showEditDocPicker}
        onOpenChange={setShowEditDocPicker}
        title="Select Docs"
        items={linkableDocs.map((d) => ({ id: d.id, name: d.title, pinned: d.pinned }))}
        selectedIds={new Set(editDocIds)}
        onToggle={(did) =>
          setEditDocIds((prev) =>
            prev.includes(did) ? prev.filter((i) => i !== did) : [...prev, did],
          )
        }
        icon={FileText}
      />
      <PickerDialog
        open={showEditEnvVarPicker}
        onOpenChange={setShowEditEnvVarPicker}
        title="Select Secrets"
        items={linkableEnvVars}
        selectedIds={new Set(editEnvVarIds)}
        onToggle={(evid) =>
          setEditEnvVarIds((prev) =>
            prev.includes(evid) ? prev.filter((i) => i !== evid) : [...prev, evid],
          )
        }
        icon={KeyRound}
        nameClass="font-mono"
      />

      {/* Trigger Dialog */}
      <TriggerDialog
        jobId={id}
        jobName={job.name}
        open={showTrigger}
        onOpenChange={setShowTrigger}
        workflow={isWorkflow}
      />
    </div>
  );
}
