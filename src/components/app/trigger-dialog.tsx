"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface TriggerDialogProps {
  jobId: string;
  jobName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowOnly?: boolean;
}

export function TriggerDialog({ jobId, jobName, open, onOpenChange, workflowOnly }: TriggerDialogProps) {
  const queryClient = useQueryClient();
  const [instructions, setInstructions] = useState("");
  const [triggering, setTriggering] = useState(false);

  async function handleTrigger() {
    setTriggering(true);
    try {
      const body: Record<string, string> = {};
      if (instructions.trim()) body.instructions = instructions.trim();

      const res = await fetch(`/api/jobs/${jobId}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        alert("Failed to trigger run");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", jobId] });
      setInstructions("");
      onOpenChange(false);
    } finally {
      setTriggering(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setInstructions(""); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger &ldquo;{jobName}&rdquo;</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will create a new scheduled run for this goal immediately.
        </p>
        <div className="space-y-2">
          <Label>{workflowOnly ? "Note (optional)" : "Additional instructions (optional)"}</Label>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={workflowOnly ? "Add a note for why this was triggered..." : "Add context for this specific run..."}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={triggering}>
            Cancel
          </Button>
          <Button onClick={handleTrigger} disabled={triggering}>
            {triggering ? "Triggering..." : "Trigger"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
