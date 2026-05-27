"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Plus, Pin } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { ScopePrompt } from "@/components/app/scope-prompt";
import { useActiveOrgId } from "@/lib/hooks/use-project-filter";
import { useEnvVars, useCreateEnvVar } from "@/lib/hooks/use-env-vars";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

type EnvVar = { id: string; name: string; pinned: number; created_at: number; updated_at: number };

export default function EnvVarsPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const activeOrgId = useActiveOrgId();
  const createEnvVar = useCreateEnvVar();

  const { data: envVarsData = [], isLoading: loading } = useEnvVars();
  const envVars = envVarsData as EnvVar[];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newValue.trim()) return;
    try {
      // Created directly in the active scope (org + project); no link step in v2.
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

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Env Vars</h1>
          <p className="text-sm text-muted-foreground mt-1">Encrypted variables injected at runtime.</p>
        </div>
        <div className="flex gap-2">
          {/* TODO(v2): "Add Existing" removed — see databases/page.tsx. No
              project_id reparent route exists; new env vars land in the active scope. */}
          <Button size="sm" onClick={() => setShowNew(true)}><Plus className="h-4 w-4 mr-1" /> New Env Var</Button>
        </div>
      </div>

      {!activeOrgId ? (
        <ScopePrompt need="org" entity="env vars" />
      ) : envVars.length === 0 ? (
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
    </div>
  );
}
