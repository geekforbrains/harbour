import { NextResponse } from "next/server";
import { serializeAttachment } from "@/lib/attachments-serialize";
import { withAuthenticatedUser } from "@/lib/auth";
import { deleteRun, getRunById, getRunWithActivity, listAttachmentsByRun } from "@/lib/db/queries";
import { publicBaseUrl } from "@/lib/request-url";

export const GET = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunWithActivity(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const base = publicBaseUrl(req);
  const attachments = listAttachmentsByRun(id).map((a) => serializeAttachment(a, base));
  return NextResponse.json({ ...run, attachments });
});

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  deleteRun(id);
  return NextResponse.json({ ok: true });
});
