import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { validateThinking } from "@/lib/cli-config";
import { createJob, getAgentById, listJobsByAgent } from "@/lib/db/queries";
import {
  optionalBoolean,
  optionalGate,
  optionalString,
  optionalStringArray,
  readJson,
  requireNonEmptyString,
} from "@/lib/http";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  return NextResponse.json(listJobsByAgent(id));
});

export const POST = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await readJson(req);
  if (!body.name || !body.schedule) {
    return NextResponse.json({ error: "name and schedule are required" }, { status: 400 });
  }
  const name = requireNonEmptyString(body.name, "name");
  const instructions = optionalString(body.instructions, "instructions");
  const prerun = optionalGate(body.prerun, "prerun");
  const postrun = optionalGate(body.postrun, "postrun");
  const postrunGates = optionalBoolean(body.postrunGates, "postrunGates");
  const model = optionalString(body.model, "model")?.trim();
  const titleFormat = optionalString(body.titleFormat, "titleFormat");
  const active = optionalBoolean(body.active, "active");
  const docIds = optionalStringArray(body.docIds, "docIds");
  const envVarIds = optionalStringArray(body.envVarIds, "envVarIds");
  const tableIds = optionalStringArray(body.tableIds, "tableIds");

  // A per-job thinking override rides the agent's CLI — validate against it.
  const thinking = optionalString(body.thinking, "thinking");
  const thinkingError = validateThinking(agent.cli, thinking);
  if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });

  const normalized = normalizeSchedule(body.schedule);
  if (!normalized) {
    return NextResponse.json(
      {
        error:
          'Invalid schedule format. Use {"every":N} for intervals or {"days":[0-6],"time":"HH:MM"} for weekly.',
      },
      { status: 400 },
    );
  }

  try {
    const job = createJob(agent.project_id, id, {
      name,
      instructions,
      schedule: normalized,
      prerun,
      postrun,
      postrunGates,
      model,
      thinking,
      titleFormat,
      docIds,
      envVarIds,
      tableIds,
      active,
    });
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    // createJob throws a plain Error for a nonexistent linked resource id —
    // map it to a 400 instead of letting it bubble to a 500.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
