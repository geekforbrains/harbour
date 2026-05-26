import { NextResponse } from "next/server";
import { withAgentOrUser, AuthContext } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import {
  getRunById,
  listAttachmentsByRun,
  createFileAttachment,
  createEmbedAttachment,
  detectEmbedProvider,
  RunAttachment,
  Uploader,
} from "@/lib/db/queries";
import { receiveMultipartUploads, UploadError } from "@/lib/upload";
import { serializeAttachment } from "@/lib/attachments-serialize";
import { publicBaseUrl } from "@/lib/request-url";
import { isVideoAutoProcessEnabled } from "@/lib/db/settings";
import { isVideoFile, processVideoAttachment } from "@/lib/video-processing";

export const runtime = "nodejs";

const runOrg = (p: Record<string, string>) => orgIdForResource("run", p.id);

function uploaderFromAuth(auth: AuthContext): Uploader {
  return auth.type === "user"
    ? { type: "user", id: auth.userId, name: auth.displayName }
    : { type: "agent", id: auth.agentId, name: auth.agentName };
}

export const GET = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rows = listAttachmentsByRun(id);
    const base = publicBaseUrl(req);
    return NextResponse.json(rows.map(r => serializeAttachment(r, base)));
  },
  { role: "viewer", orgFromParams: runOrg }
);

export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const contentType = req.headers.get("content-type") || "";
    const uploader = uploaderFromAuth(auth);
    const base = publicBaseUrl(req);

    // Embed (URL) — JSON body
    if (contentType.toLowerCase().startsWith("application/json")) {
      let body: { url?: string; title?: string };
      try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
      if (!body.url) return NextResponse.json({ error: "url is required" }, { status: 400 });
      if (!detectEmbedProvider(body.url)) {
        return NextResponse.json({ error: "Invalid embed URL" }, { status: 400 });
      }
      const att = createEmbedAttachment({ runId: id, url: body.url, title: body.title ?? null, uploader });
      return NextResponse.json(serializeAttachment(att, base), { status: 201 });
    }

    // File upload — multipart/form-data
    try {
      const { files } = await receiveMultipartUploads(req, id);
      const created: RunAttachment[] = files.map(f => createFileAttachment({
        runId: id,
        filename: f.filename,
        storagePath: f.storagePath,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        uploader,
      }));

      if (isVideoAutoProcessEnabled()) {
        for (const att of created) {
          if (isVideoFile(att.mime_type, att.filename)) {
            processVideoAttachment(att.id, id);
          }
        }
      }

      return NextResponse.json(created.map(r => serializeAttachment(r, base)), { status: 201 });
    } catch (err) {
      if (err instanceof UploadError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error("[attachments POST] upload failed:", err);
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  },
  { role: "editor", orgFromParams: runOrg }
);
