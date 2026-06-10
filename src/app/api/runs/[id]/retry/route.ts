import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { addRunActivity, getRunById, requeueWorkflowRun, updateRunStatus } from "@/lib/db/queries";

const RETRYABLE = ["failed", "skipped", "killed"];

export const POST = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    // Agents may only retry their own runs.
    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auth.type === "workflow_runner") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!RETRYABLE.includes(run.status)) {
      return NextResponse.json(
        { error: `Can only retry runs with status: ${RETRYABLE.join(", ")}` },
        { status: 400 },
      );
    }

    // Agent runs go to 'pending' (the agent resumes them on next poll).
    // Workflow runs have no agent to resume — requeue as 'scheduled' so a
    // workflow runner claims a fresh attempt.
    const updated =
      run.job_kind === "workflow" ? requeueWorkflowRun(id) : updateRunStatus(id, "pending");
    const who = auth.type === "user" ? auth.displayName : auth.agentName;
    addRunActivity(id, "system", null, "System", `Run retried by **${who}**`);

    return NextResponse.json(updated);
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  },
);
