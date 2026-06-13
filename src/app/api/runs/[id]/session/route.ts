import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, updateRunSessionId } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";

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

    const body = await readJson(req);
    const sessionId = requireNonEmptyString(body.session_id, "session_id");
    const cwd = optionalString(body.cwd, "cwd");

    updateRunSessionId(id, sessionId, cwd || undefined);
    return NextResponse.json({ ok: true });
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  },
);
