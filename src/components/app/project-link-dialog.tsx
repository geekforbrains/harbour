"use client";

import { useState, useEffect } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiFetch, scoped } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useScope } from "@/lib/hooks/use-project-filter";

type Item = { id: string; name: string };

// Map the legacy string `queryKey` prop to the matching qk domain prefix.
const PREFIX_BY_KEY: Record<string, QueryKey> = {
  agents: qk.agents.all,
  jobs: qk.jobs.all,
  docs: qk.docs.all,
  "env-vars": qk.envVars.all,
  databases: qk.databases.all,
};

export function ProjectLinkDialog({
  open,
  onOpenChange,
  projectId,
  type,
  queryKey,
  fetchAllUrl,
  icon: Icon,
  title,
  nameClass,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  type: "agent" | "job" | "doc" | "env-var" | "database";
  queryKey: string;
  fetchAllUrl: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  nameClass?: string;
}) {
  const queryClient = useQueryClient();
  const { orgId } = useScope();
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const toItems = (data: unknown): Item[] =>
      Array.isArray(data)
        ? data.map((i: { id: string; name?: string; title?: string }) => ({
            id: i.id,
            name: i.name || i.title || "",
          }))
        : [];
    Promise.all([
      // All items in the org scope.
      apiFetch(scoped(fetchAllUrl, { orgId })).catch(() => []),
      // Items already linked to this project.
      apiFetch(scoped(fetchAllUrl, { orgId, projectId })).catch(() => []),
    ]).then(([all, linked]) => {
      setAllItems(toItems(all));
      setLinkedItems(toItems(linked));
      setLoading(false);
    });
  }, [open, fetchAllUrl, projectId, orgId]);

  const linkedIds = new Set(linkedItems.map(i => i.id));
  const unlinked = allItems.filter(i => !linkedIds.has(i.id));

  async function handleLink(itemId: string) {
    await apiFetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: { action: "link", type, targetId: itemId },
    });
    const item = allItems.find(i => i.id === itemId);
    if (item) setLinkedItems(prev => [...prev, item]);
    queryClient.invalidateQueries({ queryKey: PREFIX_BY_KEY[queryKey] ?? [queryKey] });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading...</p>
        ) : unlinked.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">All items are already in this project.</p>
        ) : (
          <div className="space-y-0.5 max-h-80 overflow-y-auto">
            {unlinked.map(item => (
              <button
                key={item.id}
                onClick={() => handleLink(item.id)}
                className="flex w-full items-center gap-3 rounded-lg p-2.5 hover:bg-accent/50 transition-colors text-left"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className={`text-sm font-medium flex-1 min-w-0 truncate ${nameClass || ""}`}>{item.name}</span>
              </button>
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
