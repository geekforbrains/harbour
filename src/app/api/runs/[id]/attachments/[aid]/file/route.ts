import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { getAttachmentById, getRunById } from "@/lib/db/queries";
import { uploadsDir } from "@/lib/paths";
import { contentDisposition, isInlineSafe } from "@/lib/upload";

export const runtime = "nodejs";

export const GET = withRunExecutorOrUser(
  async (_req, _auth, { params }) => {
    const { id, aid } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

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
        "Content-Disposition": contentDisposition(
          inline ? "inline" : "attachment",
          att.filename || "file",
        ),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  },
  { role: "viewer" },
);
