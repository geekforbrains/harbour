import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { addRunActivity, getRunById, requeueWorkflowRun, updateRunStatus } from "@/lib/db/queries";

const RETRYABLE = ["failed", "skipped", "killed"];

// Retry is a dashboard action — users only. Agent runs go to 'pending' (the
// runner resumes them on its next claim); workflow runs requeue as 'scheduled'.
export const POST = withAuthenticatedUser(async (_req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  if (!RETRYABLE.includes(run.status)) {
    return NextResponse.json(
      { error: `Can only retry runs with status: ${RETRYABLE.join(", ")}` },
      { status: 400 },
    );
  }

  const updated =
    run.job_kind === "workflow" ? requeueWorkflowRun(id) : updateRunStatus(id, "pending");
  addRunActivity(id, "system", null, "System", `Run retried by **${auth.displayName}**`);

  return NextResponse.json(updated);
});
