import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getAttachmentById, getProcessingByAttachment, getRunById } from "@/lib/db/queries";
import { deleteProcessingRecord } from "@/lib/db/video-processing";
import { isVideoFile, processVideoAttachment } from "@/lib/video-processing";

export const runtime = "nodejs";

const runOrg = (p: Record<string, string>) => orgIdForResource("run", p.id);

export const GET = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id, aid } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const processing = getProcessingByAttachment(aid);
    if (!processing) return NextResponse.json({ error: "No processing record" }, { status: 404 });

    return NextResponse.json(processing);
  },
  { role: "viewer", orgFromParams: runOrg },
);

export const POST = withAgentOrUser(
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
  },
  { role: "editor", orgFromParams: runOrg },
);
