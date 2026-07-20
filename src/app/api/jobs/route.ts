import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createWorkflow, listAllJobs } from "@/lib/db/queries";
import {
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  readJson,
  requireGate,
  requireNonEmptyString,
  resolveProjectId,
} from "@/lib/http";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listAllJobs(projectId));
});

// Create a first-class workflow job (no agent, shell command only).
export const POST = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  // This endpoint only creates deterministic workflow jobs. Agent jobs (and
  // agent prerun gates) go through POST /api/agents/:id/jobs.
  if (body.agentId || body.agent_id) {
    return NextResponse.json(
      { error: "To create an agent job, POST to /api/agents/:id/jobs." },
      { status: 400 },
    );
  }
  if (!body.name || !body.schedule || !(body.command ?? body.workflow)) {
    return NextResponse.json(
      { error: "name, schedule, and command are required" },
      { status: 400 },
    );
  }
  const name = requireNonEmptyString(body.name, "name");
  // The workflow command is a gate: { runtime, content }. Accept either key.
  const workflow = requireGate(body.command ?? body.workflow, "command");
  const description = optionalString(body.description, "description");
  const docIds = optionalStringArray(body.docIds, "docIds");
  const envVarIds = optionalStringArray(body.envVarIds, "envVarIds");
  const tableIds = optionalStringArray(body.tableIds, "tableIds");
  const timeoutMinutes = optionalPositiveInt(body.timeoutMinutes, "timeoutMinutes");
  const placement = optionalString(body.placement, "placement");

  const projectId = resolveProjectId(req, body);

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
    const job = createWorkflow(projectId, {
      name,
      description,
      schedule: normalized,
      workflow,
      timeoutMinutes,
      placement: placement ?? undefined,
      docIds,
      envVarIds,
      tableIds,
    });
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    // createWorkflow throws a plain Error for a nonexistent linked resource id —
    // map it to a 400 instead of letting it bubble to a 500.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
