import { NextResponse } from "next/server";
import { withAuth, withUserAuth } from "@/lib/auth";
import { listAllJobs, createJob } from "@/lib/db/queries";
import { normalizeSchedule } from "@/lib/schedule";

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listAllJobs(projectId, workspaceId));
});

// Create an agentless workflow-only job
export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  const { name, description, schedule, workflowCommand, docIds, envVarIds } = body;
  if (!name || !schedule || !workflowCommand) {
    return NextResponse.json({ error: "name, schedule, and workflowCommand are required" }, { status: 400 });
  }
  const normalized = normalizeSchedule(schedule);
  if (!normalized) {
    return NextResponse.json({ error: "Invalid schedule format. Use {\"every\":N} for intervals or {\"days\":[0-6],\"time\":\"HH:MM\"} for weekly." }, { status: 400 });
  }
  const job = createJob(null, {
    name,
    description,
    schedule: normalized,
    workflowCommand,
    workflowOnly: true,
    docIds,
    envVarIds,
  });
  return NextResponse.json(job, { status: 201 });
});
