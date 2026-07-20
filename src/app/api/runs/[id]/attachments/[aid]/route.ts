import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { deleteAttachment, getAttachmentById, getRunById } from "@/lib/db/queries";

export const runtime = "nodejs";

// Run-bound: the wrapper ties an exec token to this run id, so run A's token
// can't delete run B's attachments. Any authenticated user also passes.
export const DELETE = withRunExecutorOrUser(async (_req, _auth, { params }) => {
  const { id, aid } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const att = getAttachmentById(aid);
  if (!att || att.run_id !== id) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  deleteAttachment(aid);
  return NextResponse.json({ ok: true });
});
