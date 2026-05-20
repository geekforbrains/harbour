"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Bot, Check, Copy, Plug, RefreshCw, Search, Server, Sparkles, Upload, X } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";

type LibraryId = "skills" | "plugins" | "subAgents";

type LibraryEntry = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  category: string | null;
  scope: string | null;
  owner_workspace: string | null;
  owner_project: string | null;
  allowed_scopes: string[];
  credential_status: string | null;
  load_policy: string | null;
  risk_level: string | null;
  human_gate: string | null;
  path: string | null;
  capsule: string | null;
  handoff_contract: string | null;
  tags: string[];
  triggers: string[];
  provenance: string | null;
};

type ToolkitLibrary = {
  id: LibraryId;
  label: string;
  path: string;
  vmPath: string;
  entries: LibraryEntry[];
};

type ToolkitResponse = {
  orgo: {
    endpoint: string;
    vm_root: string;
    public_namespace: string;
    mount_mode: string;
    scope_modes: string[];
  };
  libraries: ToolkitLibrary[];
};

type Skill = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  status: string;
  owner_workspace: string | null;
  owner_project: string | null;
  source_agent: string | null;
  path: string | null;
  digest: string | null;
  tags?: string | null;
  triggers?: string | null;
};

type Proposal = Skill & {
  content: string;
};

const libraryMeta: Record<LibraryId, { label: string; icon: typeof Sparkles }> = {
  skills: { label: "Skills", icon: Sparkles },
  plugins: { label: "Plugins", icon: Plug },
  subAgents: { label: "Sub-agents", icon: Bot },
};

function splitStoredList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function skillToEntry(skill: Skill): LibraryEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.digest || skill.description,
    status: skill.status,
    category: "imported-skill",
    scope: skill.scope,
    owner_workspace: skill.owner_workspace,
    owner_project: skill.owner_project,
    allowed_scopes: [skill.scope],
    credential_status: null,
    load_policy: "scope-match",
    risk_level: null,
    human_gate: null,
    path: skill.path,
    capsule: null,
    handoff_contract: null,
    tags: splitStoredList(skill.tags),
    triggers: splitStoredList(skill.triggers),
    provenance: skill.source_agent ? `Imported from ${skill.source_agent}.` : null,
  };
}

function entryScopes(entry: LibraryEntry) {
  return entry.scope ? [entry.scope] : entry.allowed_scopes;
}

function entryText(entry: LibraryEntry) {
  return [
    entry.name,
    entry.description,
    entry.category,
    entry.scope,
    entry.owner_workspace,
    entry.owner_project,
    entry.credential_status,
    entry.load_policy,
    entry.risk_level,
    entry.handoff_contract,
    entry.tags.join(" "),
    entry.triggers.join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}

export default function SkillsPage() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeLibrary, setActiveLibrary] = useState<LibraryId>("skills");
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [showProposal, setShowProposal] = useState(false);
  const [proposalName, setProposalName] = useState("");
  const [proposalScope, setProposalScope] = useState("global");
  const [proposalContent, setProposalContent] = useState("");
  const [copiedVm, setCopiedVm] = useState(false);

  const { data: toolkit, isLoading: toolkitLoading } = useQuery<ToolkitResponse>({
    queryKey: ["toolkit-libraries"],
    queryFn: async () => {
      const res = await fetch("/api/toolkit-libraries");
      if (!res.ok) throw new Error("Failed to load toolkit libraries");
      return res.json();
    },
  });

  const { data: importedSkills = [], isLoading: skillsLoading } = useQuery<Skill[]>({
    queryKey: ["skills"],
    queryFn: async () => {
      const res = await fetch("/api/skills");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: proposals = [] } = useQuery<Proposal[]>({
    queryKey: ["skill-proposals"],
    queryFn: async () => {
      const res = await fetch("/api/skills/proposals?status=proposed");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const libraries = useMemo(() => {
    const base = toolkit?.libraries || [];
    const importedById = new Map(importedSkills.map(skill => [skill.id, skillToEntry(skill)]));
    return base.map(library => {
      if (library.id !== "skills") return library;
      const merged = new Map(library.entries.map(entry => [entry.id, entry]));
      for (const [id, entry] of importedById) merged.set(id, { ...merged.get(id), ...entry });
      return { ...library, entries: [...merged.values()] };
    });
  }, [toolkit, importedSkills]);

  const currentLibrary = libraries.find(library => library.id === activeLibrary);
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (currentLibrary?.entries || []).filter(entry => {
      const matchesQuery = !q || entryText(entry).includes(q);
      const scopes = entryScopes(entry);
      const matchesScope = scopeFilter === "all" || scopes.includes(scopeFilter);
      return matchesQuery && matchesScope;
    });
  }, [currentLibrary, query, scopeFilter]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["toolkit-libraries"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    await queryClient.invalidateQueries({ queryKey: ["skill-proposals"] });
  }

  async function importFilesystem() {
    await fetch("/api/skills/import", { method: "POST" });
    await refresh();
  }

  async function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/skills/upload", { method: "POST", body: form });
    if (!res.ok) alert((await res.json()).error || "Upload failed");
    await refresh();
  }

  async function submitProposal(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/skills/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: proposalName, scope: proposalScope, content: proposalContent }),
    });
    if (res.ok) {
      setProposalName("");
      setProposalContent("");
      setProposalScope("global");
      setShowProposal(false);
      await refresh();
    }
  }

  async function proposalAction(id: string, action: "promote" | "reject") {
    await fetch(`/api/skills/proposals/${id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refresh();
  }

  function copyVmManifest() {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const payload = {
      endpoint: `${origin}${toolkit?.orgo.endpoint || "/api/toolkit-libraries"}`,
      vmRoot: toolkit?.orgo.vm_root,
      mountMode: toolkit?.orgo.mount_mode,
      libraries: libraries.map(library => ({ id: library.id, hostPath: library.path, vmPath: library.vmPath, entries: library.entries.length })),
    };
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopiedVm(true);
    window.setTimeout(() => setCopiedVm(false), 2000);
  }

  if (toolkitLoading || skillsLoading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Toolkit Libraries</h1>
          <p className="text-sm text-muted-foreground mt-1">Scoped capabilities for Harbour, Orgo VMs, OpenCLaw, and Hermes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1.5" /> Refresh</Button>
          {activeLibrary === "skills" && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.zip"
                className="hidden"
                onChange={e => e.target.files?.[0] && upload(e.target.files[0])}
              />
              <Button variant="outline" size="sm" onClick={importFilesystem}><RefreshCw className="h-4 w-4 mr-1.5" /> Import</Button>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-1.5" /> Upload</Button>
              <Button size="sm" onClick={() => setShowProposal(true)}><Sparkles className="h-4 w-4 mr-1.5" /> Propose</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {libraries.map(library => {
          const Icon = libraryMeta[library.id].icon;
          const isActive = activeLibrary === library.id;
          return (
            <button
              key={library.id}
              onClick={() => setActiveLibrary(library.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "hover:bg-accent/50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Icon className={isActive ? "h-4 w-4 text-primary" : "h-4 w-4 text-muted-foreground"} />
                  <span className="text-sm font-medium">{libraryMeta[library.id].label}</span>
                </div>
                <Badge variant="secondary" className="text-[10px]">{library.entries.length}</Badge>
              </div>
              <p className="mt-2 truncate text-[11px] font-mono text-muted-foreground">{library.vmPath}</p>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Orgo VM Access</p>
              <p className="text-xs text-muted-foreground">{toolkit?.orgo.vm_root} · {toolkit?.orgo.mount_mode}</p>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 lg:max-w-2xl">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">{toolkit?.orgo.endpoint}</code>
            <Button variant="outline" size="sm" onClick={copyVmManifest}>
              {copiedVm ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
              {copiedVm ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search libraries" className="pl-8" />
        </div>
        <select className="rounded-md border bg-background px-3 py-2 text-sm" value={scopeFilter} onChange={e => setScopeFilter(e.target.value)}>
          <option value="all">All scopes</option>
          <option value="global">Global</option>
          <option value="workspace">Workspace</option>
          <option value="project">Project</option>
          <option value="brand-kit">Brand kit</option>
        </select>
      </div>

      {activeLibrary === "skills" && proposals.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Proposals</h2>
          <div className="grid gap-2">
            {proposals.map(proposal => (
              <div key={proposal.id} className="flex items-start gap-3 rounded-lg border p-3">
                <Sparkles className="h-4 w-4 mt-1 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{proposal.name}</span>
                    <Badge variant="secondary" className="text-[10px]">{proposal.scope}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{proposal.digest || proposal.description}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => proposalAction(proposal.id, "reject")}><X className="h-3.5 w-3.5" /></Button>
                <Button size="sm" onClick={() => proposalAction(proposal.id, "promote")}><Check className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {filteredEntries.length === 0 ? (
        <EmptyState large icon={<Sparkles className="h-10 w-10 text-muted-foreground/40" />}>
          No library entries match the current filters.
        </EmptyState>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {filteredEntries.map(entry => (
            <div key={entry.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{entry.name}</span>
                {entryScopes(entry).map(scope => <Badge key={scope} variant="secondary" className="text-[10px]">{scope}</Badge>)}
                {entry.risk_level && <Badge className="text-[10px]" variant={entry.risk_level === "high" ? "destructive" : "secondary"}>{entry.risk_level}</Badge>}
                {entry.status !== "active" && <Badge className="text-[10px]">{entry.status}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-2 line-clamp-3">{entry.description || entry.handoff_contract || "No description available."}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {entry.category && <Badge variant="outline" className="text-[10px]">{entry.category}</Badge>}
                {entry.credential_status && <Badge variant="outline" className="text-[10px]">{entry.credential_status}</Badge>}
                {entry.load_policy && <Badge variant="outline" className="text-[10px]">{entry.load_policy}</Badge>}
                {entry.human_gate && <Badge variant="outline" className="text-[10px]">{entry.human_gate}</Badge>}
              </div>
              {(entry.owner_workspace || entry.owner_project) && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {[entry.owner_workspace, entry.owner_project].filter(Boolean).join(" / ")}
                </p>
              )}
              {(entry.path || entry.capsule) && <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/80">{entry.path || entry.capsule}</p>}
              {(entry.tags.length > 0 || entry.triggers.length > 0) && (
                <p className="mt-2 line-clamp-2 text-[11px] text-muted-foreground/80">
                  {[...entry.tags.slice(0, 5), ...entry.triggers.slice(0, 3)].join(" · ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={showProposal} onOpenChange={setShowProposal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Propose Skill</DialogTitle></DialogHeader>
          <form onSubmit={submitProposal} className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={proposalName} onChange={e => setProposalName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Scope</Label>
              <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={proposalScope} onChange={e => setProposalScope(e.target.value)}>
                <option value="global">Global</option>
                <option value="workspace">Workspace</option>
                <option value="project">Project</option>
                <option value="brand-kit">Brand Kit</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>SKILL.md Content</Label>
              <Textarea value={proposalContent} onChange={e => setProposalContent(e.target.value)} rows={8} required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowProposal(false)}>Cancel</Button>
              <Button type="submit">Create Proposal</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
