import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { listRunningRuns, listWaitingRuns, listRecentRuns, listScheduledRuns, createOneOffRun } from "@/lib/db/queries";
import { getRecentRunsLimit } from "@/lib/db/settings";

export const GET = withAuth(async (req) => {
  const filter = req.nextUrl.searchParams.get("filter");
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  if (filter === "waiting") {
    return NextResponse.json(listWaitingRuns(projectId));
  }
  const limit = getRecentRunsLimit();
  if (filter === "recent") {
    return NextResponse.json(listRecentRuns(limit, projectId));
  }

  // Default: return all sections
  return NextResponse.json({
    scheduled: listScheduledRuns(projectId),
    running: listRunningRuns(projectId),
    waiting: listWaitingRuns(projectId),
    recent: listRecentRuns(limit, projectId),
  });
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  if (!body.agentId || !body.name) {
    return NextResponse.json({ error: "agentId and name are required" }, { status: 400 });
  }

  const result = createOneOffRun(body.agentId, {
    name: body.name,
    instructions: body.instructions,
    docIds: body.docIds,
    envVarIds: body.envVarIds,
    runAt: body.runAt,
  });

  return NextResponse.json(result, { status: 201 });
});
