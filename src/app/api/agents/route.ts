import { NextResponse } from "next/server";
import { withProjectAuth } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import { createAgent, listAgents } from "@/lib/db/queries";
import { saveRunnerConfig } from "@/lib/runners";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

export const GET = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    return NextResponse.json(listAgents(projectId));
  },
  { role: "viewer" },
);

export const POST = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    const body = await req.json();
    const { name, description, cli, model, thinking, color, eager, remote } = body;
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!cli) {
      return NextResponse.json({ error: "cli is required" }, { status: 400 });
    }
    const cliError = validateCli(cli);
    if (cliError) return NextResponse.json({ error: cliError }, { status: 400 });
    const thinkingError = validateThinking(cli, thinking);
    if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });

    let agent: ReturnType<typeof createAgent>;
    try {
      agent = createAgent(projectId, name, description, {
        cli,
        model,
        thinking,
        color,
        eager: !!eager,
        remote: !!remote,
      });
    } catch (err) {
      if (err instanceof NameCollisionError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof InvalidNameError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // Local agents run on this machine, so register them with the co-located
    // runner now. Remote agents are registered on their own machine via
    // `npm run harbour -- agent connect`. Either way the runner config is
    // identity-only —
    // cli/model/thinking are resolved live from the /next payload, so changing
    // them in the dashboard takes effect without touching the runner.
    if (!remote) {
      const baseUrl = req.headers.get("origin") || `http://localhost:${process.env.PORT || 3000}`;
      saveRunnerConfig({
        agentId: agent.id,
        name: agent.name,
        apiKey: agent.apiKey,
        url: baseUrl,
      });
    }

    return NextResponse.json(agent, { status: 201 });
  },
  { role: "editor" },
);
