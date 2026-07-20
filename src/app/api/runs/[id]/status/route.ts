import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import {
  addRunActivity,
  getRunById,
  IllegalRunStatusTransition,
  updateRunStatus,
} from "@/lib/db/queries";
import { readJson } from "@/lib/http";

const AGENT_RUN_STATUSES = ["running", "waiting", "pending", "done", "failed", "skipped", "killed"];
// Workflow runs are non-interactive: no message thread, so the human-loop
// statuses (waiting/pending) don't apply. Retry requeues them as 'scheduled'.
const WORKFLOW_RUN_STATUSES = ["running", "done", "failed", "skipped", "killed"];

// Lightweight status read. The full run detail (GET /api/runs/:id) is user-only,
// so the runner can't use it to check the status it just set — it would always
// read "running" and wrongly fail the run. The executor (this run's exec token)
// and users may read just { status }.
export const GET = withRunExecutorOrUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json({ status: run.status });
});

export const PUT = withRunExecutorOrUser(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const body = await readJson(req);
  const validStatuses = run.job_kind === "workflow" ? WORKFLOW_RUN_STATUSES : AGENT_RUN_STATUSES;
  // 400: not a valid status value. 409 (below): a valid value but an illegal
  // transition from the run's current status (the lifecycle guard).
  if (typeof body.status !== "string" || !validStatuses.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${validStatuses.join(", ")}` },
      { status: 400 },
    );
  }
  const status = body.status;

  // An executor reports OUTCOMES (waiting/done/failed/skipped/killed). It must
  // not resurrect a run by flipping it to 'pending' — that's a human retry/
  // resume action (the /retry route or a user comment). Closes the path where
  // a leaked exec token re-queues a finished run for another execution.
  if (auth.type === "executor" && status === "pending") {
    return NextResponse.json({ error: "Executors cannot set status to pending" }, { status: 403 });
  }

  const isNoOp = run.status === status;

  let updated: ReturnType<typeof updateRunStatus>;
  try {
    updated = updateRunStatus(id, status);
  } catch (err) {
    if (err instanceof IllegalRunStatusTransition) {
      return NextResponse.json(
        { error: `Cannot change run status from ${err.from} to ${err.to}` },
        { status: 409 },
      );
    }
    throw err;
  }
  // Only log a status-change activity when the status actually changed — an
  // idempotent self-transition is a no-op and a "Status changed" entry would
  // be misleading.
  if (!isNoOp) {
    addRunActivity(id, "system", null, "System", `Status changed to **${status}**`);
  }

  return NextResponse.json(updated);
});
