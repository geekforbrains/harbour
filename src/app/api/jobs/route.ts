import { NextResponse } from "next/server";
import { withProjectAuth } from "@/lib/auth";
import { listAllJobs, createJob } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    return NextResponse.json(listAllJobs(projectId));
  },
  { role: "viewer" }
);

// Create an agentless workflow-only job (no agent, shell command only).
export const POST = withProjectAuth(
  async (req) => {
    const projectId = req.nextUrl.searchParams.get("projectId")!;
    const body = await req.json();
    const { name, description, schedule, workflowCommand, docIds, envVarIds } = body;
    if (!name || !schedule || !workflowCommand) {
      return NextResponse.json({ error: "name, schedule, and workflowCommand are required" }, { status: 400 });
    }
    const normalized = normalizeSchedule(schedule);
    if (!normalized) {
      return NextResponse.json({ error: "Invalid schedule format. Use {\"every\":N} for intervals or {\"days\":[0-6],\"time\":\"HH:MM\"} for weekly." }, { status: 400 });
    }
    const job = createJob(projectId, null, {
      name,
      description,
      schedule: normalized,
      workflowCommand,
      docIds,
      envVarIds,
    });
    return NextResponse.json(job, { status: 201 });
  },
  { role: "editor" }
);
