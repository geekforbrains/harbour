import { NextResponse } from "next/server";
import { withProjectAuth } from "@/lib/auth";
import { listAgents, createAgent } from "@/lib/db/queries";
import { saveRunnerConfig } from "@/lib/runners";

export const GET = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    return NextResponse.json(listAgents(projectId));
  },
  { role: "viewer" }
);

export const POST = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    const body = await req.json();
    const { name, description, cli, model, thinking, color, eager } = body;
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!cli) {
      return NextResponse.json({ error: "cli is required" }, { status: 400 });
    }

    const agent = createAgent(projectId, name, description, {
      cli,
      model,
      thinking,
      color,
      eager: !!eager,
    });

    // Save runner config locally so the CLI can poll on the same machine.
    const baseUrl = req.headers.get("origin") || `http://localhost:${process.env.PORT || 3000}`;
    saveRunnerConfig({
      agentId: agent.id,
      name: agent.name,
      apiKey: agent.apiKey,
      cli,
      model: model || null,
      thinking: thinking || null,
      eager: !!eager,
      url: baseUrl,
    });

    return NextResponse.json(agent, { status: 201 });
  },
  { role: "editor" }
);
