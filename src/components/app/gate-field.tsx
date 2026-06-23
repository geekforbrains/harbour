"use client";

import { Code2, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { SELECT_CLASS } from "@/components/app/model-thinking-select";
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
import { DEFAULT_RUNTIME, type Gate, RUNTIME_META, RUNTIMES, type Runtime } from "@/lib/runtimes";

type Props = {
  /** Shown on the row and in the dialog title — "Prerun", "Postrun", "Command". */
  label: string;
  /** The current gate, or null when unset. */
  value: Gate | null;
  /** Called with the new gate, or null when the script is removed. */
  onChange: (gate: Gate | null) => void;
  /** Helper text under the row. */
  description?: string;
  /** A required gate (e.g. a workflow command) can't be removed. */
  required?: boolean;
  /** Placeholder body shown in the empty editor. */
  placeholder?: string;
};

/**
 * Gist-style editor for a job gate: a compact row showing whether the script is
 * set (and in which runtime), with a button that opens a dialog to pick the
 * runtime and write the body. Shared by the create dialog and the job/workflow
 * detail page so prerun, postrun, and workflow commands are authored the same
 * way. Fully controlled — the parent owns the {@link Gate} value.
 */
export function GateField({ label, value, onChange, description, required, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<Runtime>(value?.runtime ?? DEFAULT_RUNTIME);
  const [content, setContent] = useState(value?.content ?? "");

  function openEditor() {
    // Seed the draft from the current value each time it opens (an edit may have
    // happened since mount, and Cancel must not leak a stale draft back).
    setRuntime(value?.runtime ?? DEFAULT_RUNTIME);
    setContent(value?.content ?? "");
    setOpen(true);
  }

  function save() {
    if (content.trim() === "") return; // Save is disabled; guard anyway.
    onChange({ runtime, content });
    setOpen(false);
  }

  function remove() {
    onChange(null);
    setOpen(false);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Code2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">{label}</span>
          {value ? (
            <span className="rounded bg-background border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {RUNTIME_META[value.runtime].label}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not set</span>
          )}
        </div>
        <button
          type="button"
          onClick={openEditor}
          aria-label={`${value ? "Edit" : "Add"} ${label} script`}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors shrink-0"
        >
          {value ? (
            <>
              <Pencil className="h-3 w-3" /> Edit
            </>
          ) : (
            <>
              <Plus className="h-3 w-3" /> Add
            </>
          )}
        </button>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>
              {value ? "Edit" : "Add"} {label} Script
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Runtime</Label>
              <select
                value={runtime}
                onChange={(e) => setRuntime(e.target.value as Runtime)}
                className={SELECT_CLASS}
              >
                {RUNTIMES.map((r) => (
                  <option key={r} value={r}>
                    {RUNTIME_META[r].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Script</Label>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="font-mono text-xs max-h-[45vh]"
                placeholder={placeholder ?? "#!/usr/bin/env bash\nset -euo pipefail"}
              />
              <p className="text-xs text-muted-foreground">
                Runs from the job's working directory with the run payload on stdin. Exit 0 =
                success, 77 = skip, other = fail.
              </p>
            </div>
            <DialogFooter>
              {value && !required && (
                <Button type="button" variant="ghost" onClick={remove} className="mr-auto">
                  Remove
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={save} disabled={content.trim() === ""}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
