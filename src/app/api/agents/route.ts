import { NextResponse } from "next/server";
import { withProjectAuth } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import { createAgent, listAgents } from "@/lib/db/queries";
import { optionalBoolean, optionalString, readJson, requireNonEmptyString } from "@/lib/http";
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
    const body = await readJson(req);
    const name = requireNonEmptyString(body.name, "name");
    const description = optionalString(body.description, "description");
    const model = optionalString(body.model, "model");
    const color = optionalString(body.color, "color");
    const eager = optionalBoolean(body.eager, "eager");
    const remote = optionalBoolean(body.remote, "remote");
    const thinking = optionalString(body.thinking, "thinking");
    const cli = body.cli;
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
        cli: cli as string,
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
