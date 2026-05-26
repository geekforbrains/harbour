import { NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/auth";
import { getNextWorkflowRun } from "@/lib/db/queries";

export const GET = withAgentAuth(async (_req, auth) => {
  const payload = getNextWorkflowRun(auth.orgId);
  if (!payload) return NextResponse.json(null);
  return NextResponse.json(payload);
});
