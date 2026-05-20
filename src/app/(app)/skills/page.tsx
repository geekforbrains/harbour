"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Upload, RefreshCw, Check, X } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";

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
};

type Proposal = Skill & {
  content: string;
};

export default function SkillsPage() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showProposal, setShowProposal] = useState(false);
  const [proposalName, setProposalName] = useState("");
  const [proposalScope, setProposalScope] = useState("global");
  const [proposalContent, setProposalContent] = useState("");

  const { data: skills = [], isLoading } = useQuery<Skill[]>({
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

  async function refresh() {
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

  if (isLoading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted-foreground mt-1">Reusable capabilities resolved before agent runs.</p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

      {proposals.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Proposals</h2>
          <div className="grid gap-2">
            {proposals.map(proposal => (
              <div key={proposal.id} className="flex items-start gap-3 rounded-lg border p-3">
                <Sparkles className="h-4 w-4 mt-1 text-primary" />
                <div className="flex-1 min-w-0">
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

      {skills.length === 0 ? (
        <EmptyState large icon={<Sparkles className="h-10 w-10 text-muted-foreground/40" />}>
          No skills imported yet. Import from SKILLS or upload a SKILL.md.
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {skills.map(skill => (
            <div key={skill.id} className="rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                <Badge variant="secondary" className="text-[10px]">{skill.scope}</Badge>
                {skill.status !== "active" && <Badge className="text-[10px]">{skill.status}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{skill.digest || skill.description || "No digest available."}</p>
              {skill.path && <p className="text-[11px] text-muted-foreground/70 mt-2 font-mono truncate">{skill.path}</p>}
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
