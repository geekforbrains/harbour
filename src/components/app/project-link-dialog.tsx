"use client";

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Item = { id: string; name: string };

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
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [linkedItems, setLinkedItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true);
    });
    Promise.all([
      // Fetch ALL items (no project filter)
      fetch(fetchAllUrl).then(r => r.json()),
      // Fetch items linked to this project
      fetch(`${fetchAllUrl}${fetchAllUrl.includes("?") ? "&" : "?"}projectId=${projectId}`).then(r => r.json()),
    ]).then(([all, linked]) => {
      const allArr = Array.isArray(all) ? all : [];
      const linkedArr = Array.isArray(linked) ? linked : [];
      setAllItems(allArr.map((i: any) => ({ id: i.id, name: i.name || i.title || i.name })));
      setLinkedItems(linkedArr.map((i: any) => ({ id: i.id, name: i.name || i.title || i.name })));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fetchAllUrl, projectId]);

  const linkedIds = new Set(linkedItems.map(i => i.id));
  const unlinked = allItems.filter(i => !linkedIds.has(i.id));

  async function handleLink(itemId: string) {
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link", type, targetId: itemId }),
    });
    const item = allItems.find(i => i.id === itemId);
    if (item) setLinkedItems(prev => [...prev, item]);
    queryClient.invalidateQueries({ queryKey: [queryKey] });
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
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Icon className="h-3.5 w-3.5 text-primary" />
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
