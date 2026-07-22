import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import {
  createAgent,
  getLlmConnectionById,
  LlmConnectionValidationError,
  listAgents,
  validateLlmModelForProvider,
} from "@/lib/db/queries";
import {
  optionalBoolean,
  optionalString,
  readJson,
  requireNonEmptyString,
  resolveProjectId,
} from "@/lib/http";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listAgents(projectId));
});

export const POST = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  const projectId = resolveProjectId(req, body);
  const name = requireNonEmptyString(body.name, "name");
  const description = optionalString(body.description, "description");
  const model = optionalString(body.model, "model")?.trim();
  const color = optionalString(body.color, "color");
  const eager = optionalBoolean(body.eager, "eager");
  const placement = optionalString(body.placement, "placement");
  const thinking = optionalString(body.thinking, "thinking");
  const llmConnectionId =
    body.llm_connection_id === undefined || body.llm_connection_id === null
      ? undefined
      : requireNonEmptyString(body.llm_connection_id, "llm_connection_id");
  const cli = body.cli;
  if (!cli) {
    return NextResponse.json({ error: "cli is required" }, { status: 400 });
  }
  const cliError = validateCli(cli);
  if (cliError) return NextResponse.json({ error: cliError }, { status: 400 });
  const thinkingError = validateThinking(cli, thinking);
  if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });

  if (cli === "opencode") {
    if (!llmConnectionId) {
      return NextResponse.json(
        { error: "OpenCode agents require llm_connection_id" },
        { status: 400 },
      );
    }
    const connection = getLlmConnectionById(llmConnectionId);
    if (!connection || connection.project_id !== projectId) {
      return NextResponse.json(
        { error: "LLM connection not found in this project" },
        { status: 400 },
      );
    }
    const modelError = validateLlmModelForProvider(connection.provider_id, model);
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });
  } else if (llmConnectionId) {
    return NextResponse.json(
      { error: "llm_connection_id is only supported for OpenCode agents" },
      { status: 400 },
    );
  }

  let agent: ReturnType<typeof createAgent>;
  try {
    agent = createAgent(projectId, name, description, {
      cli: cli as string,
      model,
      thinking,
      color,
      eager: !!eager,
      placement: placement ?? undefined,
      llmConnectionId,
    });
  } catch (err) {
    if (err instanceof NameCollisionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof LlmConnectionValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // No per-agent runner config to write: the unified runner claims this
  // agent's work via POST /api/runner/claim (the DB `runners` table is the
  // registry), and cli/model/thinking are resolved live from the claim payload.
  return NextResponse.json(agent, { status: 201 });
});
