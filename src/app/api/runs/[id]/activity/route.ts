import { NextResponse } from "next/server";
import { withAuthenticatedUser, withRunExecutorOrUser } from "@/lib/auth";
import {
  addRunActivity,
  getRunById,
  linkAttachmentsToActivity,
  listRunActivity,
  updateRunStatus,
} from "@/lib/db/queries";
import { optionalString, optionalStringArray, readJson } from "@/lib/http";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json(listRunActivity(id));
});

// Users may comment (intentional — comments can resume a waiting run), and the
// run's executor posts activity as it works. Workflow runs are the exception:
// their activity log is runner output only, never a conversation (guard below).
export const POST = withRunExecutorOrUser(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Workflow runs are non-interactive: their activity log is runner output,
  // not a message thread. Only the executor may write to it.
  if (run.job_kind === "workflow" && auth.type !== "executor") {
    return NextResponse.json(
      { error: "Workflow runs do not have a message thread" },
      { status: 400 },
    );
  }

  const body = await readJson(req);
  const content = (optionalString(body.content, "content") ?? "").trim();
  const attachmentIds = optionalStringArray(body.attachment_ids, "attachment_ids") ?? [];

  if (!content && attachmentIds.length === 0) {
    return NextResponse.json({ error: "content or attachment_ids required" }, { status: 400 });
  }

  // Author: a workflow-run executor authors as 'workflow'; an agent-run
  // executor as 'agent'; a dashboard user as 'user'.
  let authorType: string;
  let authorId: string | null;
  let authorName: string;
  if (auth.type === "user") {
    authorType = "user";
    authorId = auth.userId;
    authorName = auth.displayName;
  } else if (auth.runKind === "workflow") {
    authorType = "workflow";
    authorId = auth.runId;
    authorName = auth.agentName ?? "Runner";
  } else {
    authorType = "agent";
    authorId = auth.agentId ?? auth.runId;
    authorName = auth.agentName ?? "Agent";
  }

  const entry = addRunActivity(id, authorType, authorId, authorName, content);

  if (attachmentIds.length > 0) {
    linkAttachmentsToActivity(attachmentIds, entry.id, id);
  }

  // When a user responds, move to pending (ready for executor pickup). 'killed'
  // runs can also be resumed via a comment.
  if (authorType === "user" && ["waiting", "done", "failed", "killed"].includes(run.status)) {
    updateRunStatus(id, "pending");
    addRunActivity(id, "system", null, "System", "Status changed to **pending**");
  }

  return NextResponse.json(entry, { status: 201 });
});
