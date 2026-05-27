import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, updateRunStatus, addRunActivity } from "@/lib/db/queries";

const VALID_STATUSES = ["running", "waiting", "pending", "done", "failed", "skipped", "killed"];

export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== null && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    if (!body.status || !VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
    }

    const updated = updateRunStatus(id, body.status);
    addRunActivity(id, "system", null, "System", `Status changed to **${body.status}**`);

    return NextResponse.json(updated);
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);
