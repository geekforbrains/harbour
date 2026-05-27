"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { BackLink } from "@/components/app/back-link";
import { KeyRound, Eye, EyeOff, Pin, Pencil, Trash2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { useEnvVar, useEnvVarMutations } from "@/lib/hooks/use-env-vars";

type EnvVar = { id: string; name: string; pinned: number; created_at: number; updated_at: number };

export default function EnvVarDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [showValue, setShowValue] = useState(false);
  const [decryptedValue, setDecryptedValue] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [showEditValue, setShowEditValue] = useState(false);

  const [showDelete, setShowDelete] = useState(false);

  const { data: envVarData, isLoading: loading } = useEnvVar(id, { refetchInterval: 5000 });
  const envVar = (envVarData as EnvVar | undefined) ?? null;

  const { update, remove, togglePin, revealValue } = useEnvVarMutations(id);
  const saving = update.isPending;
  const loadingValue = revealValue.isPending;

  async function handleReveal() {
    if (decryptedValue !== null) {
      setShowValue(!showValue);
      return;
    }
    try {
      const data = await revealValue.mutateAsync();
      setDecryptedValue(data.value);
      setShowValue(true);
    } catch {
      // leave value hidden on failure
    }
  }

  async function handleTogglePin() {
    try {
      await togglePin.mutateAsync();
    } catch {
      alert("Failed to toggle pin");
    }
  }

  function startEditing() {
    if (!envVar) return;
    setEditName(envVar.name);
    setEditValue("");
    setShowEditValue(false);
    setEditing(true);
  }

  async function handleSave() {
    const body: Record<string, string> = {};
    if (editName !== envVar?.name) body.name = editName;
    if (editValue) body.value = editValue;
    if (Object.keys(body).length > 0) {
      try {
        await update.mutateAsync(body);
      } catch {
        alert("Failed to save env var");
        return;
      }
      // Clear cached decrypted value if value was changed
      if (editValue) {
        setDecryptedValue(null);
        setShowValue(false);
      }
    }
    setEditing(false);
  }

  async function handleDelete() {
    try {
      await remove.mutateAsync();
    } catch {
      alert("Failed to delete env var");
      return;
    }
    router.push("/env-vars");
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;
  if (!envVar) return <div className="text-sm text-muted-foreground py-12 text-center">Env var not found.</div>;

  return (
    <div className="space-y-6">
      <BackLink href="/env-vars" label="Env Vars" />

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight font-mono">{envVar.name}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Created {timeAgo(envVar.created_at)} · Updated {timeAgo(envVar.updated_at)}</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button variant={envVar.pinned ? "default" : "outline"} size="icon" className="h-8 w-8" onClick={handleTogglePin} title={envVar.pinned ? "Unpin" : "Pin to all jobs"}>
            <Pin className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={startEditing} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setShowDelete(true)} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Value display */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Value</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg border bg-muted/50 px-3 py-2.5 font-mono text-sm min-h-[40px] flex items-center">
            {showValue && decryptedValue !== null ? (
              <span className="break-all">{decryptedValue}</span>
            ) : (
              <span className="text-muted-foreground">{"•".repeat(32)}</span>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={handleReveal}
            disabled={loadingValue}
            title={showValue ? "Hide value" : "Reveal value"}
          >
            {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Env Var</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={editName}
                onChange={e => setEditName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <div className="flex gap-2">
                <Input
                  type={showEditValue ? "text" : "password"}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  placeholder="Leave empty to keep current value"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setShowEditValue(!showEditValue)}
                >
                  {showEditValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Leave empty to keep the current value unchanged.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Env Var</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-mono font-medium text-foreground">{envVar.name}</span>? It will be removed from all jobs.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
