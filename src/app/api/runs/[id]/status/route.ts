import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import {
  addRunActivity,
  getRunById,
  IllegalRunStatusTransition,
  updateRunStatus,
} from "@/lib/db/queries";

const AGENT_RUN_STATUSES = ["running", "waiting", "pending", "done", "failed", "skipped", "killed"];
// Workflow runs are non-interactive: no message thread, so the human-loop
// statuses (waiting/pending) don't apply. Retry requeues them as 'scheduled'.
const WORKFLOW_RUN_STATUSES = ["running", "done", "failed", "skipped", "killed"];

// Lightweight status read. The full run detail (GET /api/runs/:id) is
// withResourceAuth (user/admin only), so a runner can't use it to check the
// status it just set — it would always read "running" and wrongly fail the run.
// This mirrors the PUT's agent-ownership check and returns only { status }.
export const GET = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auth.type === "workflow_runner" && run.job_kind !== "workflow") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ status: run.status });
  },
  {
    role: "viewer",
    allowWorkflowRunner: true,
    orgFromParams: (p) => orgIdForResource("run", p.id),
  },
);

export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auth.type === "workflow_runner" && run.job_kind !== "workflow") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validStatuses = run.job_kind === "workflow" ? WORKFLOW_RUN_STATUSES : AGENT_RUN_STATUSES;
    // 400: not a valid status value. 409 (below): a valid value but an illegal
    // transition from the run's current status (the lifecycle guard).
    if (!body.status || !validStatuses.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 },
      );
    }

    const isNoOp = run.status === body.status;

    let updated: ReturnType<typeof updateRunStatus>;
    try {
      updated = updateRunStatus(id, body.status);
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
      addRunActivity(id, "system", null, "System", `Status changed to **${body.status}**`);
    }

    return NextResponse.json(updated);
  },
  {
    role: "editor",
    allowWorkflowRunner: true,
    orgFromParams: (p) => orgIdForResource("run", p.id),
  },
);
