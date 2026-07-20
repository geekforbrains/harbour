import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { getAttachmentById, getProcessingByAttachment, getRunById } from "@/lib/db/queries";
import { deleteProcessingRecord } from "@/lib/db/video-processing";
import { isVideoFile, processVideoAttachment } from "@/lib/video-processing";

export const runtime = "nodejs";

export const GET = withRunExecutorOrUser(async (_req, _auth, { params }) => {
  const { id, aid } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Confine to the run in the URL (mirrors the POST below): an exec token is
  // pinned to `id`, so a foreign attachment id must 404, not leak the record.
  const processing = getProcessingByAttachment(aid);
  if (!processing || processing.run_id !== id) {
    return NextResponse.json({ error: "No processing record" }, { status: 404 });
  }

  return NextResponse.json(processing);
});

export const POST = withRunExecutorOrUser(async (_req, _auth, { params }) => {
  const { id, aid } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const att = getAttachmentById(aid);
  if (!att || att.run_id !== id) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  if (!isVideoFile(att.mime_type, att.filename)) {
    return NextResponse.json({ error: "Attachment is not a video" }, { status: 400 });
  }

  const existing = getProcessingByAttachment(aid);
  if (existing) {
    if (existing.status === "queued" || existing.status === "processing") {
      return NextResponse.json({ error: "Already processing" }, { status: 409 });
    }
    deleteProcessingRecord(existing.id);
  }

  processVideoAttachment(aid, id);
  return NextResponse.json({ status: "queued" }, { status: 202 });
});
