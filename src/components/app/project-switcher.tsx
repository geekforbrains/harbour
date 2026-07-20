"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { qk, SCOPED_DOMAINS } from "@/lib/api/keys";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import { useCreateProject } from "@/lib/hooks/use-projects";
import { useApp } from "./app-context";
import { SlugPreview } from "./slug-preview";

export function ProjectSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const { projects, activeProjectId, setActiveProjectId } = useApp();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");

  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;

  /** Invalidate every scope-carrying query so lists refetch under the new scope. */
  function invalidateScoped() {
    for (const prefix of SCOPED_DOMAINS) {
      queryClient.invalidateQueries({ queryKey: prefix });
    }
  }

  function handleSelectProject(id: string | null) {
    setActiveProjectId(id);
    invalidateScoped();
  }

  function closeNewProject() {
    setShowNew(false);
    setNewName("");
    createProject.reset();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    let project: Awaited<ReturnType<typeof createProject.mutateAsync>>;
    try {
      project = await createProject.mutateAsync(newName.trim());
    } catch {
      return; // surfaced inline from createProject.error; leave dialog open
    }
    closeNewProject();
    // Wait for the projects list to refetch so the new id isn't masked as stale.
    await queryClient.invalidateQueries({ queryKey: qk.projects.all });
    handleSelectProject(project.id);
  }

  const label = activeProject ? activeProject.name : "All Projects";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={
            variant === "mobile"
              ? "flex items-center gap-1.5 text-sm font-semibold tracking-tight"
              : "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          }
        >
          {variant === "sidebar" && <FolderOpen className="h-4 w-4 shrink-0" />}
          <span
            className={
              variant === "mobile" ? "truncate max-w-[200px]" : "flex-1 truncate text-left"
            }
          >
            {label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => handleSelectProject(null)}>
            <span className="flex-1">All Projects</span>
            {!activeProjectId && <Check className="h-4 w-4 ml-2 text-primary" />}
          </DropdownMenuItem>
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => handleSelectProject(p.id)}>
              <span className="flex-1 truncate">{p.name}</span>
              {activeProjectId === p.id && <Check className="h-4 w-4 ml-2 text-primary" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={showNew}
        onOpenChange={(open) => {
          if (!open) closeNewProject();
          else setShowNew(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Marketing"
                autoFocus
                required
              />
              <SlugPreview name={newName} />
              {createProject.isError && (
                <p className="text-xs text-destructive">
                  {mutationErrorMessage(createProject.error, "Failed to create project")}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeNewProject}>
                Cancel
              </Button>
              <Button type="submit" disabled={createProject.isPending}>
                {createProject.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
