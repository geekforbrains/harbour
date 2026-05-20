"use client";

import { useMemo, useState } from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Building2, ChevronDown, Check, FolderOpen, Layers3, Plus } from "lucide-react";

function invalidateScopedLists(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  queryClient.invalidateQueries({ queryKey: ["projects"] });
  queryClient.invalidateQueries({ queryKey: ["agents"] });
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  queryClient.invalidateQueries({ queryKey: ["runs"] });
  queryClient.invalidateQueries({ queryKey: ["docs"] });
  queryClient.invalidateQueries({ queryKey: ["env-vars"] });
  queryClient.invalidateQueries({ queryKey: ["databases"] });
  queryClient.invalidateQueries({ queryKey: ["runs", "waiting-count"] });
}

export function WorkspaceProjectList() {
  const {
    projects,
    activeWorkspaceId,
    activeProjectId,
    setActiveProjectId,
  } = useApp();
  const queryClient = useQueryClient();

  if (!activeWorkspaceId) return null;

  const workspaceProjects = projects.filter(project => project.workspace_id === activeWorkspaceId);

  if (workspaceProjects.length === 0) {
    return (
      <div className="px-3 pb-2 text-xs text-muted-foreground/70">
        No projects in this workspace.
      </div>
    );
  }

  return (
    <div className="px-2 pb-2">
      <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        Projects
      </p>
      <div className="space-y-0.5">
        {workspaceProjects.map(project => (
          <button
            key={project.id}
            type="button"
            onClick={() => {
              setActiveProjectId(project.id);
              invalidateScopedLists(queryClient);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              activeProjectId === project.id
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {activeProjectId === project.id && <Check className="h-3.5 w-3.5 shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProjectSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const {
    workspaces,
    projects,
    activeWorkspaceId,
    setActiveWorkspaceId,
    activeProjectId,
    setActiveProjectId,
  } = useApp();
  const queryClient = useQueryClient();
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creating, setCreating] = useState(false);

  const activeWorkspace = activeWorkspaceId ? workspaces.find(w => w.id === activeWorkspaceId) : null;
  const activeProject = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;
  const projectsByWorkspace = useMemo(() => {
    const grouped = new Map<string, typeof projects>();
    for (const project of projects) {
      const key = project.workspace_id || "none";
      grouped.set(key, [...(grouped.get(key) || []), project]);
    }
    return grouped;
  }, [projects]);

  function handleWorkspaceSelect(id: string | null) {
    setActiveWorkspaceId(id);
    invalidateScopedLists(queryClient);
  }

  function handleProjectSelect(id: string | null) {
    setActiveProjectId(id);
    invalidateScopedLists(queryClient);
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName.trim(), workspaceId: activeWorkspaceId }),
    });
    if (res.ok) {
      const project = await res.json();
      setNewProjectName("");
      setShowNewProject(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      handleProjectSelect(project.id);
    }
    setCreating(false);
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!newWorkspaceName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newWorkspaceName.trim() }),
    });
    if (res.ok) {
      const workspace = await res.json();
      setNewWorkspaceName("");
      setShowNewWorkspace(false);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      handleWorkspaceSelect(workspace.id);
    }
    setCreating(false);
  }

  const triggerLabel = activeProject
    ? activeProject.name
    : activeWorkspace
      ? activeWorkspace.name
      : variant === "mobile" ? "BORG Interface" : "All Workspaces";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={variant === "mobile"
          ? "flex items-center gap-1.5 text-sm font-semibold tracking-tight"
          : "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        }>
          {variant === "sidebar" && (activeProject ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Building2 className="h-4 w-4 shrink-0" />)}
          <span className={variant === "mobile" ? "truncate max-w-[200px]" : "flex-1 truncate text-left"}>
            {triggerLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem onClick={() => handleWorkspaceSelect(null)}>
            <Layers3 className="h-4 w-4" />
            <span className="flex-1">All Workspaces</span>
            {!activeWorkspaceId && !activeProjectId && <Check className="h-4 w-4 ml-2 text-primary" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {workspaces.map(workspace => {
            const workspaceProjects = projectsByWorkspace.get(workspace.id) || [];
            return (
              <div key={workspace.id}>
                <DropdownMenuItem onClick={() => handleWorkspaceSelect(workspace.id)}>
                  <Building2 className="h-4 w-4" />
                  <span className="flex-1 truncate font-medium">{workspace.name}</span>
                  {activeWorkspaceId === workspace.id && !activeProjectId && <Check className="h-4 w-4 ml-2 text-primary" />}
                </DropdownMenuItem>
                {workspaceProjects.map(project => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => {
                      if (project.workspace_id && project.workspace_id !== activeWorkspaceId) setActiveWorkspaceId(project.workspace_id);
                      handleProjectSelect(project.id);
                    }}
                  >
                    <FolderOpen className="h-4 w-4 ml-5" />
                    <span className="flex-1 truncate">{project.name}</span>
                    {activeProjectId === project.id && <Check className="h-4 w-4 ml-2 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setShowNewProject(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShowNewWorkspace(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Project</DialogTitle></DialogHeader>
          <form onSubmit={handleCreateProject} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="e.g. Client Portal" autoFocus required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNewProject(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewWorkspace} onOpenChange={setShowNewWorkspace}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Workspace</DialogTitle></DialogHeader>
          <form onSubmit={handleCreateWorkspace} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={newWorkspaceName} onChange={e => setNewWorkspaceName(e.target.value)} placeholder="e.g. New Business" autoFocus required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNewWorkspace(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
