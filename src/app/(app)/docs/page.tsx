"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FileText, Pin, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionTooltip } from "@/components/app/action-tooltip";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
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
import { useCreateDoc, useDocs } from "@/lib/hooks/use-docs";
import { useActiveOrgId } from "@/lib/hooks/use-project-filter";
import { timeAgo } from "@/lib/time";

type Doc = { id: string; title: string; pinned: number; updated_at: number };

export default function DocsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const activeOrgId = useActiveOrgId();
  const createDoc = useCreateDoc();

  const { data: docsData = [], isLoading: loading } = useDocs();
  const docs = docsData as Doc[];

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      // Created directly in the active scope (org + project) by useCreateDoc;
      // no separate link step in v2.
      const doc = await createDoc.mutateAsync({ title: newTitle });
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

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Docs"
        subtitle="Shared knowledge linked to jobs."
        actions={
          <div className="flex gap-2">
            {/* TODO(v2): "Add Existing" removed — see tables/page.tsx. No
                project_id reparent route exists; new docs land in the active scope. */}
            <ActionTooltip
              hint={activeOrgId ? undefined : "Select an organization to create a doc."}
            >
              <Button size="sm" onClick={() => setShowNew(true)} disabled={!activeOrgId}>
                <Plus className="h-4 w-4 mr-1" /> New Doc
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      <ListState
        scope={activeOrgId}
        scopeNeed="org"
        scopeEntity="docs"
        isEmpty={docs.length === 0}
        emptyIcon={<FileText className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No docs yet."
      >
        <div className="space-y-2">
          {docs.map((doc) => (
            <RowLink key={doc.id} href={`/docs/${doc.id}`}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-medium flex-1 pt-1">{doc.title}</span>
              <button
                type="button"
                onClick={(e) => handleTogglePin(e, doc.id)}
                className={`shrink-0 p-1 rounded transition-colors ${doc.pinned ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                title={doc.pinned ? "Unpin" : "Pin to all jobs"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs text-muted-foreground pt-1">{timeAgo(doc.updated_at)}</span>
            </RowLink>
          ))}
        </div>
      </ListState>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Doc</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Brand Voice Guide"
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
              <Button type="submit">Create Doc</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
