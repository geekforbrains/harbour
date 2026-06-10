"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronDown, FolderOpen, Plus } from "lucide-react";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api/client";
import { qk, SCOPED_DOMAINS } from "@/lib/api/keys";
import { useCreateOrg } from "@/lib/hooks/use-orgs";
import { useCreateProject } from "@/lib/hooks/use-projects";
import { useApp } from "./app-context";

export function ProjectSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const { user, orgs, activeOrgId, setActiveOrgId, projects, activeProjectId, setActiveProjectId } =
    useApp();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const createOrg = useCreateOrg();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgTz, setNewOrgTz] = useState("");

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

  // Timezones for the New Org dialog; fetched only once the dialog is opened.
  const { data: timezones = [] } = useQuery<string[]>({
    queryKey: qk.settings.timezones(),
    queryFn: () => apiFetch<string[]>("/api/settings/timezones"),
    enabled: showNewOrg,
    staleTime: Infinity,
  });

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    const org = await createOrg.mutateAsync({
      name: newOrgName.trim(),
      timezone: newOrgTz || undefined,
    });
    setNewOrgName("");
    setNewOrgTz("");
    setShowNewOrg(false);
    // me/orgs are invalidated by the hook; jump straight into the new org.
    handleSelectOrg(org.id);
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
          {showOrgPicker && (
            <>
              <DropdownMenuGroup>
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
                {isAdmin && (
                  <DropdownMenuItem onClick={() => setShowNewOrg(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    New Org
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuGroup>
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
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setShowNew(true)} disabled={!activeOrgId}>
            <Plus className="h-4 w-4 mr-2" />
            New Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showNew} onOpenChange={setShowNew}>
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
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNew(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createProject.isPending}>
                {createProject.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewOrg} onOpenChange={setShowNewOrg}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Organization</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateOrg} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="e.g. Acme Co."
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <select
                value={newOrgTz}
                onChange={(e) => setNewOrgTz(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">System default</option>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Used for this org&apos;s schedule calculations.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowNewOrg(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createOrg.isPending}>
                {createOrg.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
