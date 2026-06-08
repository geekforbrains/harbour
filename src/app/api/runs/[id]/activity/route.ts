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
// agents post activity as they work. Workflow runs are the exception: their
// activity log is runner output only, never a conversation (see guard below).
export const POST = withAgentOrUser(
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
    // Workflow runs are non-interactive: their activity log is runner output,
    // not a message thread. Only the workflow runner may write to it.
    if (run.job_kind === "workflow" && auth.type !== "workflow_runner") {
      return NextResponse.json({ error: "Workflow runs do not have a message thread" }, { status: 400 });
    }

    const body = await req.json() as { content?: string; attachment_ids?: string[] };
    const content = (body.content ?? "").trim();
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

    if (!content && attachmentIds.length === 0) {
      return NextResponse.json({ error: "content or attachment_ids required" }, { status: 400 });
    }

    const authorType = auth.type === "user"
      ? "user"
      : auth.type === "workflow_runner"
        ? "workflow"
        : "agent";
    const authorId = auth.type === "user"
      ? auth.userId
      : auth.type === "workflow_runner"
        ? auth.runnerId
        : auth.agentId;
    const authorName = auth.type === "user"
      ? auth.displayName
      : auth.type === "workflow_runner"
        ? auth.runnerName
        : auth.agentName;

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
    allowWorkflowRunner: true,
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);
