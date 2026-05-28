import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, updateRunSessionId } from "@/lib/db/queries";

export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auth.type === "workflow_runner") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    if (!body.session_id || typeof body.session_id !== "string") {
      return NextResponse.json({ error: "session_id is required" }, { status: 400 });
    }

    updateRunSessionId(id, body.session_id, body.cwd || undefined);
    return NextResponse.json({ ok: true });
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);
