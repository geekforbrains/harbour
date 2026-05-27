"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileText, Plus, Pin, Link2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { useActiveProjectId } from "@/lib/hooks/use-project-filter";
import { useDocs, useCreateDoc } from "@/lib/hooks/use-docs";
import { useProjectMutations } from "@/lib/hooks/use-projects";
import { apiFetch } from "@/lib/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/api/keys";
import { ProjectLinkDialog } from "@/components/app/project-link-dialog";

type Doc = { id: string; title: string; pinned: number; updated_at: number };

export default function DocsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [showLinkExisting, setShowLinkExisting] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const activeProjectId = useActiveProjectId();
  const createDoc = useCreateDoc();
  const { link } = useProjectMutations();

  const { data: docsData = [], isLoading: loading } = useDocs();
  const docs = docsData as Doc[];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const doc = await createDoc.mutateAsync({ title: newTitle });
      if (activeProjectId) {
        await link.mutateAsync({ projectId: activeProjectId, type: "doc", targetId: doc.id });
      }
      router.push(`/docs/${doc.id}?edit=1`);
    } catch {
      // ignore; stays on page
    }
  }

  async function handleTogglePin(e: React.MouseEvent, docId: string) {
    e.preventDefault();
    try {
      await apiFetch(`/api/docs/${docId}/pin`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: qk.docs.all });
    } catch {
      // ignore
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
          <p className="text-sm text-muted-foreground mt-1">Shared knowledge linked to jobs.</p>
        </div>
        <div className="flex gap-2">
          {activeProjectId && (
            <Button variant="outline" size="sm" onClick={() => setShowLinkExisting(true)}>
              <Link2 className="h-4 w-4 mr-1.5" /> Add Existing
            </Button>
          )}
          <Button size="sm" onClick={() => setShowNew(true)}><Plus className="h-4 w-4 mr-1" /> New Doc</Button>
        </div>
      </div>

      {docs.length === 0 ? (
        <EmptyState large icon={<FileText className="h-10 w-10 text-muted-foreground/40" />}>
          No docs yet.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <Link key={doc.id} href={`/docs/${doc.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-medium flex-1 pt-1">{doc.title}</span>
              <button
                onClick={e => handleTogglePin(e, doc.id)}
                className={`shrink-0 p-1 rounded transition-colors ${doc.pinned ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                title={doc.pinned ? "Unpin" : "Pin to all jobs"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs text-muted-foreground pt-1">{timeAgo(doc.updated_at)}</span>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Doc</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. Brand Voice Guide" autoFocus required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
              <Button type="submit">Create Doc</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {activeProjectId && (
        <ProjectLinkDialog
          open={showLinkExisting}
          onOpenChange={setShowLinkExisting}
          projectId={activeProjectId}
          type="doc"
          queryKey="docs"
          fetchAllUrl="/api/docs"
          icon={FileText}
          title="Add Existing Doc"
        />
      )}
    </div>
  );
}
