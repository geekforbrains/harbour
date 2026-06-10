"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTriggerJob } from "@/lib/hooks/use-jobs";

interface TriggerDialogProps {
  jobId: string;
  jobName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow?: boolean;
}

export function TriggerDialog({
  jobId,
  jobName,
  open,
  onOpenChange,
  workflow,
}: TriggerDialogProps) {
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
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setInstructions("");
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger &ldquo;{jobName}&rdquo;</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will create a new scheduled run for this job immediately.
        </p>
        <div className="space-y-2">
          <Label>{workflow ? "Note (optional)" : "Additional instructions (optional)"}</Label>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={
              workflow
                ? "Add a note for why this was triggered..."
                : "Add context for this specific run..."
            }
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
