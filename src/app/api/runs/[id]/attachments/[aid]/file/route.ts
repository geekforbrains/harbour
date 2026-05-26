import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, getAttachmentById } from "@/lib/db/queries";
import { uploadsDir } from "@/lib/paths";

export const runtime = "nodejs";

const INLINE_TYPES = [/^image\//, /^video\//, /^audio\//, /^application\/pdf$/];

function isInline(mime: string | null): boolean {
  if (!mime) return false;
  return INLINE_TYPES.some(re => re.test(mime));
}

export const GET = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id, aid } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const att = getAttachmentById(aid);
    if (!att || att.run_id !== id || att.kind !== "file" || !att.storage_path) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    const abs = path.join(uploadsDir(), att.storage_path);
    if (!fs.existsSync(abs)) {
      return NextResponse.json({ error: "File missing on disk" }, { status: 404 });
    }

    const stat = fs.statSync(abs);
    const mime = att.mime_type || "application/octet-stream";
    const dispositionType = isInline(mime) ? "inline" : "attachment";
    const safeFilename = (att.filename || "file").replace(/"/g, "");

    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": stat.size.toString(),
        "Content-Disposition": `${dispositionType}; filename="${safeFilename}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  },
  { role: "viewer", orgFromParams: (p) => orgIdForResource("run", p.id) }
);
