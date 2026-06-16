import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { stalledPlacements } from "@/lib/db/queries";

// The absent-runner surface for the active scope: placements with queued work
// (scheduled/pending runs) that no live runner is serving. The dashboard shows a
// banner from this so a run pinned to an unconnected placement never silently
// stalls. Org-scoped (optional projectId narrows further, dual-tier).
export const GET = withOrgAuth(
  async (req, auth) => {
    const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
    return NextResponse.json({ stalled: stalledPlacements(auth.orgId, projectId) });
  },
  { role: "viewer" },
);
