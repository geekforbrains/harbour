import { NextResponse } from "next/server";
import { withResourceAuth, withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import {
  getRunById,
  addRunActivity,
  listRunActivity,
  updateRunStatus,
  linkAttachmentsToActivity,
} from "@/lib/db/queries";

export const GET = withResourceAuth("run", "id", { role: "viewer" })(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    return NextResponse.json(listRunActivity(id));
  }
);

// Viewers may comment (intentional — comments can resume a waiting run), and
// agents post activity as they work.
export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json() as { content?: string; attachment_ids?: string[] };
    const content = (body.content ?? "").trim();
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

    if (!content && attachmentIds.length === 0) {
      return NextResponse.json({ error: "content or attachment_ids required" }, { status: 400 });
    }

    const authorType = auth.type === "user" ? "user" : "agent";
    const authorId = auth.type === "user" ? auth.userId : auth.agentId;
    const authorName = auth.type === "user" ? auth.displayName : auth.agentName;

    const entry = addRunActivity(id, authorType, authorId, authorName, content);

    if (attachmentIds.length > 0) {
      linkAttachmentsToActivity(attachmentIds, entry.id, id);
    }

    // When a user responds, move to pending (ready for agent pickup). 'killed'
    // runs can also be resumed via a comment.
    if (authorType === "user" && ["waiting", "done", "failed", "killed"].includes(run.status)) {
      updateRunStatus(id, "pending");
      addRunActivity(id, "system", null, "System", "Status changed to **pending**");
    }

    return NextResponse.json(entry, { status: 201 });
  },
  {
    role: "viewer",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);
