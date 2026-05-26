import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, getAttachmentById, deleteAttachment } from "@/lib/db/queries";

export const runtime = "nodejs";

export const DELETE = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id, aid } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const att = getAttachmentById(aid);
    if (!att || att.run_id !== id) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    deleteAttachment(aid);
    return NextResponse.json({ ok: true });
  },
  { role: "editor", orgFromParams: (p) => orgIdForResource("run", p.id) }
);
