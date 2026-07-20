"use client";

import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pin, Plus } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ProjectBadge } from "@/components/app/project-badge";
import { RowLink } from "@/components/app/row-link";
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
import { useCreateEnvVar, useEnvVars } from "@/lib/hooks/use-env-vars";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { timeAgo } from "@/lib/time";

type EnvVar = {
  id: string;
  name: string;
  pinned: number;
  project_name: string;
  created_at: number;
  updated_at: number;
};

export default function EnvVarsPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const activeProjectId = useActiveProjectId();
  const createEnvVar = useCreateEnvVar();

  const { data: envVarsData = [], isLoading: loading } = useEnvVars();
  const envVars = envVarsData as EnvVar[];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newValue.trim()) return;
    try {
      // Created directly in the active project.
      await createEnvVar.mutateAsync({ name: newName.trim(), value: newValue });
      setShowNew(false);
      setNewName("");
      setNewValue("");
    } catch {
      // ignore
    }
  }

  async function handleTogglePin(e: React.MouseEvent, id: string) {
    e.preventDefault();
    try {
      await apiFetch(`/api/env-vars/${id}/pin`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: qk.envVars.all });
    } catch {
      // ignore
    }
  }

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Secrets"
        subtitle="Encrypted variables injected at runtime."
        actions={
          <div className="flex gap-2">
            {/* TODO(v2): "Add Existing" removed — see tables/page.tsx. No
                project_id reparent route exists; new env vars land in the active project. */}
            <ActionTooltip
              hint={activeProjectId ? undefined : "Select a project to create a secret."}
            >
              <Button size="sm" onClick={() => setShowNew(true)} disabled={!activeProjectId}>
                <Plus className="h-4 w-4 mr-1" /> New Secret
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      <ListState
        isEmpty={envVars.length === 0}
        emptyIcon={<KeyRound className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No secrets yet."
      >
        <div className="space-y-2">
          {envVars.map((ev) => (
            <RowLink key={ev.id} href={`/env-vars/${ev.id}`} align="center">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-mono font-medium flex-1 truncate">{ev.name}</span>
              {!activeProjectId && <ProjectBadge name={ev.project_name} />}
              <button
                type="button"
                onClick={(e) => handleTogglePin(e, ev.id)}
                className={`shrink-0 p-1 rounded transition-colors ${ev.pinned ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                title={ev.pinned ? "Unpin" : "Pin to all jobs"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs text-muted-foreground">{timeAgo(ev.updated_at)}</span>
            </RowLink>
          ))}
        </div>
      </ListState>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Secret</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) =>
                  setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))
                }
                placeholder="e.g. GITHUB_TOKEN"
                className="font-mono"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="Secret value"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
