"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "./app-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderOpen, ChevronDown, Plus, Check, Building2 } from "lucide-react";
import { SCOPED_DOMAINS, qk } from "@/lib/api/keys";
import { useCreateProject } from "@/lib/hooks/use-projects";

export function ProjectSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const {
    user,
    orgs,
    activeOrgId,
    setActiveOrgId,
    projects,
    activeProjectId,
    setActiveProjectId,
  } = useApp();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");

  const isAdmin = !!user?.isInstanceAdmin;
  const activeProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : null;
  const activeOrg = activeOrgId ? orgs.find((o) => o.id === activeOrgId) : null;
  const showOrgPicker = isAdmin || orgs.length > 1;

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

  function handleSelectOrg(id: string | null) {
    setActiveOrgId(id);
    // Switching org drops the current project selection (it belonged to the old org).
    setActiveProjectId(null);
    invalidateScoped();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const project = await createProject.mutateAsync(newName.trim());
    setNewName("");
    setShowNew(false);
    await queryClient.invalidateQueries({ queryKey: qk.projects.all });
    handleSelectProject(project.id);
  }

  const label = activeProject
    ? activeProject.name
    : activeOrg
      ? activeOrg.name
      : variant === "mobile"
        ? "Harbour"
        : isAdmin
          ? "All Orgs"
          : "All Projects";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={variant === "mobile"
          ? "flex items-center gap-1.5 text-sm font-semibold tracking-tight"
          : "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        }>
          {variant === "sidebar" && <FolderOpen className="h-4 w-4 shrink-0" />}
          <span className={variant === "mobile" ? "truncate max-w-[200px]" : "flex-1 truncate text-left"}>
            {label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {showOrgPicker && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> Organization
              </DropdownMenuLabel>
              {isAdmin && (
                <DropdownMenuItem onClick={() => handleSelectOrg(null)}>
                  <span className="flex-1">All Orgs</span>
                  {!activeOrgId && <Check className="h-4 w-4 ml-2 text-primary" />}
                </DropdownMenuItem>
              )}
              {orgs.map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => handleSelectOrg(o.id)}>
                  <span className="flex-1 truncate">{o.name}</span>
                  {activeOrgId === o.id && <Check className="h-4 w-4 ml-2 text-primary" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" /> Project
          </DropdownMenuLabel>
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
          <DropdownMenuItem onClick={() => setShowNew(true)} disabled={!activeOrgId}>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Project</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Marketing" autoFocus required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
              <Button type="submit" disabled={createProject.isPending}>{createProject.isPending ? "Creating..." : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
