import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { stalledPlacements } from "@/lib/db/queries";

// The absent-runner surface: placements with queued work (scheduled/pending
// runs) that no live runner is serving. The dashboard shows a banner from this
// so a run pinned to an unconnected placement never silently stalls. Optional
// ?projectId= narrows to one project.
export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  return NextResponse.json({ stalled: stalledPlacements(projectId) });
});
