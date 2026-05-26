"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Plus, Pin, Link2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { useProjectFilter, useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { ProjectLinkDialog } from "@/components/app/project-link-dialog";

type EnvVar = { id: string; name: string; pinned: number; created_at: number; updated_at: number };

export default function EnvVarsPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [showLinkExisting, setShowLinkExisting] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const projectFilter = useProjectFilter();
  const activeProjectId = useActiveProjectId();

  const { data: envVars = [], isLoading: loading } = useQuery<EnvVar[]>({
    queryKey: ["env-vars", projectFilter],
    queryFn: async () => {
      const res = await fetch(`/api/env-vars${projectFilter}`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newValue.trim()) return;
    const res = await fetch("/api/env-vars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), value: newValue }),
    });
    if (res.ok) {
      const envVar = await res.json();
      // Auto-link to active project
      if (activeProjectId) {
        await fetch(`/api/projects/${activeProjectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "link", type: "env-var", targetId: envVar.id }),
        });
      }
      setShowNew(false);
      setNewName("");
      setNewValue("");
      queryClient.invalidateQueries({ queryKey: ["env-vars"] });
    }
  }

  async function handleTogglePin(e: React.MouseEvent, id: string) {
    e.preventDefault();
    const res = await fetch(`/api/env-vars/${id}/pin`, { method: "POST" });
    if (!res.ok) return;
    queryClient.invalidateQueries({ queryKey: ["env-vars"] });
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Env Vars</h1>
          <p className="text-sm text-muted-foreground mt-1">Encrypted variables injected at runtime.</p>
        </div>
        <div className="flex gap-2">
          {activeProjectId && (
            <Button variant="outline" size="sm" onClick={() => setShowLinkExisting(true)}>
              <Link2 className="h-4 w-4 mr-1.5" /> Add Existing
            </Button>
          )}
          <Button size="sm" onClick={() => setShowNew(true)}><Plus className="h-4 w-4 mr-1" /> New Env Var</Button>
        </div>
      </div>

      {envVars.length === 0 ? (
        <EmptyState large icon={<KeyRound className="h-10 w-10 text-muted-foreground/40" />}>
          No env vars yet.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {envVars.map(ev => (
            <Link key={ev.id} href={`/env-vars/${ev.id}`} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-mono font-medium flex-1 truncate">{ev.name}</span>
              <button
                onClick={e => handleTogglePin(e, ev.id)}
                className={`shrink-0 p-1 rounded transition-colors ${ev.pinned ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                title={ev.pinned ? "Unpin" : "Pin to all jobs"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs text-muted-foreground">{timeAgo(ev.updated_at)}</span>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Env Var</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} placeholder="e.g. GITHUB_TOKEN" className="font-mono" autoFocus required />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Input type="password" value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Secret value" required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {activeProjectId && (
        <ProjectLinkDialog
          open={showLinkExisting}
          onOpenChange={setShowLinkExisting}
          projectId={activeProjectId}
          type="env-var"
          queryKey="env-vars"
          fetchAllUrl="/api/env-vars"
          icon={KeyRound}
          title="Add Existing Env Var"
          nameClass="font-mono"
        />
      )}
    </div>
  );
}
