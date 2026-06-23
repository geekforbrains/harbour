import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { listRunsHistory, type RunsHistoryFilters } from "@/lib/db/runs";

export const GET = withOrgAuth(
  async (req, auth) => {
    const sp = req.nextUrl.searchParams;

    const statusesParam = sp.get("status");
    const statuses = statusesParam
      ? (statusesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as RunsHistoryFilters["statuses"])
      : undefined;

    const filters: RunsHistoryFilters = {
      statuses,
      includeSkipped: sp.get("includeSkipped") === "1",
      agentId: sp.get("agentId") || undefined,
      jobId: sp.get("jobId") || undefined,
      projectId: sp.get("projectId") || undefined,
      from: sp.get("from") ? Number(sp.get("from")) : undefined,
      to: sp.get("to") ? Number(sp.get("to")) : undefined,
      sort: sp.get("sort") === "oldest" ? "oldest" : "newest",
    };

    const limit = sp.get("limit") ? Number(sp.get("limit")) : 25;
    const offset = sp.get("offset") ? Number(sp.get("offset")) : 0;

    const { runs, hasMore } = listRunsHistory(auth.orgId, filters, limit, offset);
    return NextResponse.json({ runs, hasMore, nextOffset: hasMore ? offset + runs.length : null });
  },
  { role: "viewer" },
);
