import { NextResponse } from "next/server";
import { withWorkflowRunnerAuth } from "@/lib/auth";
import { getNextWorkflowRun, peekWorkflowNext, touchWorkflowRunner } from "@/lib/db/queries";

export const GET = withWorkflowRunnerAuth(async (req, auth) => {
  touchWorkflowRunner(auth.runnerId);
  if (req.nextUrl.searchParams.get("peek") === "true") {
    return NextResponse.json(peekWorkflowNext(auth.orgId));
  }
  const payload = getNextWorkflowRun(auth.orgId);
  if (!payload) return NextResponse.json(null);
  return NextResponse.json(payload);
});
