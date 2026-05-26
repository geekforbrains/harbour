import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getRunWithActivity, getRunById, deleteRun, listAttachmentsByRun } from "@/lib/db/queries";
import { serializeAttachment } from "@/lib/attachments-serialize";
import { publicBaseUrl } from "@/lib/request-url";

export const GET = withResourceAuth("run", "id", { role: "viewer" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const run = getRunWithActivity(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const base = publicBaseUrl(req);
    const attachments = listAttachmentsByRun(id).map(a => serializeAttachment(a, base));
    return NextResponse.json({ ...run, attachments });
  }
);

export const DELETE = withResourceAuth("run", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    deleteRun(id);
    return NextResponse.json({ success: true });
  }
);
