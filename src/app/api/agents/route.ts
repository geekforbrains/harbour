import { NextResponse } from "next/server";
import { withAuth, withUserAuth } from "@/lib/auth";
import { listAgents, createAgent } from "@/lib/db/queries";
import { saveRunnerConfig } from "@/lib/runners";

function listFromInput(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(v => v.trim()).filter(Boolean);
  return [];
}

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listAgents(projectId, workspaceId));
});

export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  const {
    name, description, type, provider, cli, model, thinking, remote, eager,
    scopeType, workspaceId, projectId, composioCliEnabled, composioMcpEnabled,
  } = body;
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const agentType = type || "harbour";
  const runtimeCli = provider || cli;
  if (agentType === "harbour") {
    if (!runtimeCli) {
      return NextResponse.json({ error: "cli is required for harbour agents" }, { status: 400 });
    }
  }
  const scope = scopeType || "global";
  if (!["global", "workspace", "project"].includes(scope)) {
    return NextResponse.json({ error: "scopeType must be global, workspace, or project" }, { status: 400 });
  }
  if (scope === "workspace" && !workspaceId) {
    return NextResponse.json({ error: "workspaceId is required for workspace scoped agents" }, { status: 400 });
  }
  if (scope === "project" && !projectId) {
    return NextResponse.json({ error: "projectId is required for project scoped agents" }, { status: 400 });
  }

  const agent = createAgent(name, description, {
    type: agentType,
    cli: runtimeCli,
    model,
    thinking,
    remote: !!remote,
    eager: !!eager,
    scopeType: scope,
    workspaceId: workspaceId || null,
    projectId: projectId || null,
    composioCliEnabled: !!composioCliEnabled,
    composioMcpEnabled: !!composioMcpEnabled,
    composioToolkits: listFromInput(body.composioToolkits),
    composioTools: listFromInput(body.composioTools),
  });

  // For harbour agents running on the same machine as the server, save runner
  // config locally so the CLI can poll. Remote agents are expected to be
  // registered from the remote host via `harbour agent connect`.
  if (agentType === "harbour" && !remote) {
    const baseUrl = req.headers.get("origin") || `http://localhost:${process.env.PORT || 3000}`;
    saveRunnerConfig({
      agentId: agent.id,
      name: agent.name,
      apiKey: agent.apiKey,
      cli: runtimeCli,
      model: model || null,
      thinking: thinking || null,
      eager: !!eager,
      url: baseUrl,
    });
  }

  return NextResponse.json(agent, { status: 201 });
});
