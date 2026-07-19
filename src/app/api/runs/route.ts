import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import {
  listRecentRuns,
  listRunningRuns,
  listScheduledRuns,
  listWaitingRuns,
} from "@/lib/db/queries";
import { getRecentRunsLimit, getRecentRunsPerJob } from "@/lib/db/settings";

// NOTE: the run list queries filter by projectId only (Phase 1). Org scoping is
// enforced by withOrgAuth; full org-level run composition lands in a later phase.
export const GET = withOrgAuth(
  async (req, auth) => {
    const filter = req.nextUrl.searchParams.get("filter");
    const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
    if (filter === "waiting") {
      return NextResponse.json(listWaitingRuns(auth.orgId, projectId));
    }
    const limit = getRecentRunsLimit();
    const perJobLimit = getRecentRunsPerJob();
    if (filter === "recent") {
      return NextResponse.json(listRecentRuns(auth.orgId, limit, projectId, { perJobLimit }));
    }

    return NextResponse.json({
      scheduled: listScheduledRuns(auth.orgId, projectId),
      running: listRunningRuns(auth.orgId, projectId),
      waiting: listWaitingRuns(auth.orgId, projectId),
      recent: listRecentRuns(auth.orgId, limit, projectId, { perJobLimit }),
    });
  },
  { role: "viewer" },
);
