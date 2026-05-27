import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, getProcessingByAttachment } from "@/lib/db/queries";
import { uploadsDir } from "@/lib/paths";

export const runtime = "nodejs";

export const GET = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id, aid, index } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== null && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const processing = getProcessingByAttachment(aid);
    if (!processing || !processing.screenshots_dir) {
      return NextResponse.json({ error: "No screenshots available" }, { status: 404 });
    }

    const idx = parseInt(index, 10);
    if (isNaN(idx) || idx < 0) {
      return NextResponse.json({ error: "Invalid index" }, { status: 400 });
    }

    // Files on disk are 1-based (0001.jpg), API index is 0-based
    const filename = String(idx + 1).padStart(4, "0") + ".jpg";
    const abs = path.join(uploadsDir(), processing.screenshots_dir, filename);

    if (!fs.existsSync(abs)) {
      return NextResponse.json({ error: "Screenshot not found" }, { status: 404 });
    }

    const stat = fs.statSync(abs);
    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": stat.size.toString(),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  },
  { role: "viewer", orgFromParams: (p) => orgIdForResource("run", p.id) }
);
