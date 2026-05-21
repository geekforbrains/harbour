import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getAgentById } from "@/lib/db/queries";
import { getDb } from "@/lib/db/schema";
import { getToolkitLibraries } from "@/lib/toolkit-libraries";

type AgentScope = {
  cli?: string | null;
  workspace_id?: string | null;
  project_id?: string | null;
};

function resolveAgentWorkspace(agent: AgentScope | null) {
  if (!agent) return null;
  if (agent.workspace_id) return agent.workspace_id;
  if (!agent.project_id) return null;
  const db = getDb();
  const project = db.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(agent.project_id) as { workspace_id: string | null } | undefined;
  return project?.workspace_id || null;
}

export const GET = withAuth(async (req, auth) => {
  if (auth.type === "agent") {
    const agent = getAgentById(auth.agentId) as AgentScope | null;
    return NextResponse.json(getToolkitLibraries({
      workspaceId: resolveAgentWorkspace(agent),
      projectId: agent?.project_id || null,
      agentCli: agent?.cli || null,
    }));
  }

  const workspaceId = req.nextUrl.searchParams.get("workspaceId");
  const projectId = req.nextUrl.searchParams.get("projectId");
  const agentCli = req.nextUrl.searchParams.get("agentCli");
  const scoped = workspaceId || projectId;
  return NextResponse.json(getToolkitLibraries(scoped
    ? { workspaceId, projectId, agentCli }
    : { includeAll: true, agentCli }
  ));
});
