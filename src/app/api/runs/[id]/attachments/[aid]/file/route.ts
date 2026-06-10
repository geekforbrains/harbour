import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, getAttachmentById } from "@/lib/db/queries";
import { uploadsDir } from "@/lib/paths";
import { contentDisposition, isInlineSafe } from "@/lib/upload";

export const runtime = "nodejs";

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
    // The stored MIME type is client-declared: only allowlisted types render
    // inline with their declared type; everything else downloads as a blob.
    const inline = isInlineSafe(att.mime_type);
    const mime = inline ? (att.mime_type as string) : "application/octet-stream";

    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": stat.size.toString(),
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", att.filename || "file"),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  },
  { role: "viewer", orgFromParams: (p) => orgIdForResource("run", p.id) }
);
