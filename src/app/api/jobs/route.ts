import { NextResponse } from "next/server";
import { withProjectAuth } from "@/lib/auth";
import { createWorkflow, listAllJobs } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    return NextResponse.json(listAllJobs(projectId));
  },
  { role: "viewer" },
);

// Create a first-class workflow job (no agent, shell command only).
export const POST = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    const body = await req.json();
    const { name, description, schedule, command, docIds, envVarIds, timeoutMinutes } = body;
    // This endpoint only creates deterministic workflow jobs. Agent jobs (and
    // agent prerun gates) go through POST /api/agents/:id/jobs.
    if (body.agentId || body.agent_id) {
      return NextResponse.json(
        { error: "To create an agent job, POST to /api/agents/:id/jobs." },
        { status: 400 },
      );
    }
    if (!name || !schedule || !command) {
      return NextResponse.json(
        { error: "name, schedule, and command are required" },
        { status: 400 },
      );
    }
    const normalized = normalizeSchedule(schedule);
    if (!normalized) {
      return NextResponse.json(
        {
          error:
            'Invalid schedule format. Use {"every":N} for intervals or {"days":[0-6],"time":"HH:MM"} for weekly.',
        },
        { status: 400 },
      );
    }
    const job = createWorkflow(projectId, {
      name,
      description,
      schedule: normalized,
      command,
      timeoutMinutes,
      docIds,
      envVarIds,
    });
    return NextResponse.json(job, { status: 201 });
  },
  { role: "editor" },
);
