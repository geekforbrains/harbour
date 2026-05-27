"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useTriggerJob } from "@/lib/hooks/use-jobs";

interface TriggerDialogProps {
  jobId: string;
  jobName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowOnly?: boolean;
}

export function TriggerDialog({ jobId, jobName, open, onOpenChange, workflowOnly }: TriggerDialogProps) {
  const trigger = useTriggerJob();
  const [instructions, setInstructions] = useState("");
  const triggering = trigger.isPending;

  async function handleTrigger() {
    try {
      await trigger.mutateAsync({ jobId, instructions: instructions.trim() || undefined });
      setInstructions("");
      onOpenChange(false);
    } catch {
      alert("Failed to trigger run");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setInstructions(""); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger &ldquo;{jobName}&rdquo;</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will create a new scheduled run for this job immediately.
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
