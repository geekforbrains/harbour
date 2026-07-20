import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import {
  listRecentRuns,
  listRunningRuns,
  listScheduledRuns,
  listWaitingRuns,
} from "@/lib/db/queries";
import { getRecentRunsLimit, getRecentRunsPerJob } from "@/lib/db/settings";

// Optional ?projectId= narrows to one project; omitted, runs span every project.
export const GET = withAuthenticatedUser(async (req) => {
  const filter = req.nextUrl.searchParams.get("filter");
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  if (filter === "waiting") {
    return NextResponse.json(listWaitingRuns(projectId));
  }
  const limit = getRecentRunsLimit();
  const perJobLimit = getRecentRunsPerJob();
  if (filter === "recent") {
    return NextResponse.json(listRecentRuns(projectId, limit, { perJobLimit }));
  }

  return NextResponse.json({
    scheduled: listScheduledRuns(projectId),
    running: listRunningRuns(projectId),
    waiting: listWaitingRuns(projectId),
    recent: listRecentRuns(projectId, limit, { perJobLimit }),
  });
});
