import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { createSkillProposal, listSkillProposals } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  return NextResponse.json(listSkillProposals(req.nextUrl.searchParams.get("status") || undefined));
});

export const POST = withAuth(async (req, auth) => {
  const body = await req.json();
  if (!body.name || !body.content) {
    return NextResponse.json({ error: "name and content are required" }, { status: 400 });
  }
  const proposal = createSkillProposal({
    id: body.id,
    name: body.name,
    description: body.description,
    scope: body.scope || "global",
    owner_workspace: body.ownerWorkspace || body.owner_workspace || null,
    owner_project: body.ownerProject || body.owner_project || null,
    source_agent: body.sourceAgent || body.source_agent || (auth.type === "agent" ? auth.agentId : auth.userId),
    path: body.path || null,
    provenance: body.provenance || `Proposed through Harbour by ${auth.type}.`,
    version: body.version || null,
    dependencies: body.dependencies || null,
    agent_compatibility: body.agentCompatibility || body.agent_compatibility || ["openclaw", "hermes"],
    tags: body.tags || null,
    triggers: body.triggers || null,
    digest: body.digest || null,
    content: body.content,
  });
  return NextResponse.json(proposal, { status: 201 });
});
