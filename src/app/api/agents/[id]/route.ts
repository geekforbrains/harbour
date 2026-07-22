import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import {
  deleteAgent,
  getAgentById,
  getAgentWorkspace,
  getLlmConnectionById,
  LlmConnectionValidationError,
  listJobsByAgent,
  updateAgent,
  validateLlmModelForProvider,
} from "@/lib/db/queries";
import { optionalBoolean, optionalString, readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  // Workspace slugs let the dashboard show the agent's on-disk runner path.
  return NextResponse.json({ ...agent, workspace: getAgentWorkspace(id) });
});

export const PUT = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const existing = getAgentById(id);
  if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await readJson(req);
  // Type-guard each present field; absent fields stay untouched on update.
  const name = optionalString(body.name, "name");
  const description = optionalString(body.description, "description");
  const modelValue = optionalString(body.model, "model");
  const model = modelValue === undefined ? undefined : modelValue.trim();
  const color = optionalString(body.color, "color");
  const thinking = optionalString(body.thinking, "thinking");
  const eager = optionalBoolean(body.eager, "eager");
  const placement = optionalString(body.placement, "placement");
  // `remote` is accepted but not a stored agent field — validate it anyway so a
  // wrong-typed value is a clean 400 rather than silently ignored.
  optionalBoolean(body.remote, "remote");
  const cli = optionalString(body.cli, "cli");
  const hasLlmConnectionId = Object.hasOwn(body, "llm_connection_id");
  const llmConnectionId = !hasLlmConnectionId
    ? undefined
    : body.llm_connection_id === null
      ? null
      : requireNonEmptyString(body.llm_connection_id, "llm_connection_id");

  if (cli !== undefined) {
    const cliError = validateCli(cli);
    if (cliError) return NextResponse.json({ error: cliError }, { status: 400 });
  }
  if (cli !== undefined || thinking !== undefined) {
    // Validate the effective combination, not just the changed field — a cli
    // change alone must not strand a thinking level the new CLI rejects.
    const effectiveCli = cli !== undefined ? cli : existing.cli;
    const effectiveThinking = thinking !== undefined ? thinking : existing.thinking;
    const thinkingError = validateThinking(effectiveCli, effectiveThinking);
    if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });
  }

  const effectiveCli = cli !== undefined ? cli : existing.cli;
  let bindingUpdate = llmConnectionId;
  const effectiveConnectionId = hasLlmConnectionId ? llmConnectionId : existing.llm_connection_id;
  const configChanged = cli !== undefined || model !== undefined || hasLlmConnectionId;
  if (effectiveCli === "opencode") {
    if (!effectiveConnectionId) {
      return NextResponse.json(
        { error: "OpenCode agents require llm_connection_id" },
        { status: 400 },
      );
    }
    const connection = getLlmConnectionById(effectiveConnectionId);
    if (!connection || connection.project_id !== existing.project_id) {
      return NextResponse.json(
        { error: "LLM connection not found in this project" },
        { status: 400 },
      );
    }
    const effectiveModel = model !== undefined ? model : existing.model;
    const modelError = validateLlmModelForProvider(connection.provider_id, effectiveModel);
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });

    if (configChanged) {
      for (const job of listJobsByAgent(id) as { name: string; model: string | null }[]) {
        if (!job.model) continue;
        const jobModelError = validateLlmModelForProvider(connection.provider_id, job.model);
        if (jobModelError) {
          return NextResponse.json(
            {
              error: `Job "${job.name}" has an incompatible model override: ${jobModelError}`,
            },
            { status: 400 },
          );
        }
      }
    }
  } else {
    if (llmConnectionId) {
      return NextResponse.json(
        { error: "llm_connection_id is only supported for OpenCode agents" },
        { status: 400 },
      );
    }
    // Switching away from OpenCode also removes its provider binding in the
    // same transaction; an unrelated edit to another CLI leaves state alone.
    if (cli !== undefined && existing.llm_connection_id) bindingUpdate = null;
  }

  const updates = {
    name,
    description,
    cli,
    model,
    thinking,
    color,
    eager,
    placement: placement ?? undefined,
    llmConnectionId: bindingUpdate,
  };
  let updated: ReturnType<typeof updateAgent>;
  try {
    updated = updateAgent(id, updates);
  } catch (error) {
    if (error instanceof LlmConnectionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  // No runner config to sync — the runner reads cli/model/thinking live from
  // the claim payload, so dashboard edits take effect on the next claim.
  return NextResponse.json(updated);
});

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getAgentById(id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  deleteAgent(id);
  return NextResponse.json({ ok: true });
});
