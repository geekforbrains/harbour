import { NextResponse } from "next/server";
import { withAuth, withUserAuth } from "@/lib/auth";
import { listAgents, createAgent } from "@/lib/db/queries";
import { saveRunnerConfig } from "@/lib/runners";

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listAgents(projectId, workspaceId));
});

export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  const { name, description, type, cli, model, thinking, remote, eager } = body;
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (type === "harbour") {
    if (!cli) {
      return NextResponse.json({ error: "cli is required for harbour agents" }, { status: 400 });
    }
  }

  const agent = createAgent(name, description, type === "harbour" ? { type, cli, model, thinking, remote: !!remote, eager: !!eager } : undefined);

  // For harbour agents running on the same machine as the server, save runner
  // config locally so the CLI can poll. Remote agents are expected to be
  // registered from the remote host via `harbour agent connect`.
  if (type === "harbour" && !remote) {
    const baseUrl = req.headers.get("origin") || `http://localhost:${process.env.PORT || 3000}`;
    saveRunnerConfig({
      agentId: agent.id,
      name: agent.name,
      apiKey: agent.apiKey,
      cli: cli,
      model: model || null,
      thinking: thinking || null,
      eager: !!eager,
      url: baseUrl,
    });
  }

  return NextResponse.json(agent, { status: 201 });
});
