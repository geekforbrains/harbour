"use client";

import { Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { ListState } from "@/components/app/list-state";
import {
  buildLlmConnectionInput,
  buildLlmConnectionUpdateInput,
  createLlmConnectionDraft,
  createLlmConnectionDraftFromConnection,
  LlmConnectionFields,
  validateLlmConnectionDraft,
} from "@/components/app/llm-connection-form";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ProjectBadge } from "@/components/app/project-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import { useEnvVars } from "@/lib/hooks/use-env-vars";
import {
  type LlmConnection,
  useCreateLlmConnection,
  useDeleteLlmConnection,
  useLlmConnections,
  useUpdateLlmConnection,
} from "@/lib/hooks/use-llm-connections";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";

export default function LlmConnectionsPage() {
  const activeProjectId = useActiveProjectId();
  const { data: connections = [], isLoading } = useLlmConnections();
  const createConnection = useCreateLlmConnection();
  const updateConnection = useUpdateLlmConnection();
  const deleteConnection = useDeleteLlmConnection();

  const [showNew, setShowNew] = useState(false);
  const [newDraft, setNewDraft] = useState(createLlmConnectionDraft());
  const [editing, setEditing] = useState<LlmConnection | null>(null);
  const [editDraft, setEditDraft] = useState(createLlmConnectionDraft());
  const [deleting, setDeleting] = useState<LlmConnection | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: createSecrets = [] } = useEnvVars(undefined, { enabled: showNew });
  const { data: editSecrets = [] } = useEnvVars(
    { projectId: editing?.project_id },
    { enabled: !!editing },
  );

  function closeNew() {
    setShowNew(false);
    setNewDraft(createLlmConnectionDraft());
    setFormError(null);
    createConnection.reset();
  }

  function openNew() {
    setFormError(null);
    createConnection.reset();
    setShowNew(true);
  }

  function closeEdit() {
    setEditing(null);
    setFormError(null);
  }

  function closeDelete() {
    setDeleting(null);
    setFormError(null);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const error = validateLlmConnectionDraft(newDraft);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    try {
      await createConnection.mutateAsync(buildLlmConnectionInput(newDraft));
      closeNew();
    } catch (mutationError) {
      setFormError(mutationErrorMessage(mutationError, "Failed to create LLM connection"));
    }
  }

  function startEditing(connection: LlmConnection) {
    setEditing(connection);
    setEditDraft(createLlmConnectionDraftFromConnection(connection));
    setFormError(null);
    updateConnection.reset();
  }

  async function handleUpdate(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const error = validateLlmConnectionDraft(editDraft);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    try {
      await updateConnection.mutateAsync({
        id: editing.id,
        body: buildLlmConnectionUpdateInput(editDraft),
      });
      setEditing(null);
    } catch (mutationError) {
      setFormError(mutationErrorMessage(mutationError, "Failed to update LLM connection"));
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await deleteConnection.mutateAsync(deleting.id);
      setDeleting(null);
    } catch (mutationError) {
      setFormError(mutationErrorMessage(mutationError, "Failed to delete LLM connection"));
    }
  }

  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="LLM Connections"
        subtitle="Provider endpoints and credentials for OpenCode agents."
        actions={
          <ActionTooltip
            hint={activeProjectId ? undefined : "Select a project to create a connection."}
          >
            <Button size="sm" onClick={openNew} disabled={!activeProjectId}>
              <Plus className="mr-1 h-4 w-4" /> New Connection
            </Button>
          </ActionTooltip>
        }
      />

      <ListState
        isEmpty={connections.length === 0}
        emptyIcon={<Plug className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage={
          activeProjectId ? "No LLM connections yet." : "Select a project to create a connection."
        }
      >
        <div className="space-y-2">
          {connections.map((connection) => (
            <div key={connection.id} className="flex items-center gap-3 rounded-lg border p-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Plug className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{connection.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {connection.kind}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{connection.provider_id}</span>
                  {connection.base_url && (
                    <span className="max-w-64 truncate font-mono">{connection.base_url}</span>
                  )}
                  <span>
                    {connection.credential ? `Secret: ${connection.credential.name}` : "No API key"}
                  </span>
                  {(connection.agent_count ?? 0) > 0 && (
                    <span>
                      {connection.agent_count} agent{connection.agent_count === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </div>
              {!activeProjectId && connection.project_name && (
                <ProjectBadge name={connection.project_name} />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => startEditing(connection)}
                title="Edit connection"
                aria-label={`Edit ${connection.name}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  setDeleting(connection);
                  setFormError(null);
                }}
                title="Delete connection"
                aria-label={`Delete ${connection.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </ListState>

      <Dialog open={showNew} onOpenChange={(open) => (open ? setShowNew(true) : closeNew())}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New LLM Connection</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 pt-2">
            <LlmConnectionFields draft={newDraft} onChange={setNewDraft} secrets={createSecrets} />
            <p className="text-xs text-muted-foreground">
              Use a dedicated, budget-limited provider key. Headless agents can access credentials
              supplied to their process.
            </p>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeNew}>
                Cancel
              </Button>
              <Button type="submit" disabled={createConnection.isPending}>
                {createConnection.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            closeEdit();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit LLM Connection</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4 pt-2">
            <LlmConnectionFields draft={editDraft} onChange={setEditDraft} secrets={editSecrets} />
            {formError && <p className="text-xs text-destructive">{formError}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeEdit}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateConnection.isPending}>
                {updateConnection.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) {
            closeDelete();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete LLM Connection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">{deleting?.name}</span>?
            Connections used by agents cannot be deleted.
          </p>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConnection.isPending}
            >
              {deleteConnection.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
