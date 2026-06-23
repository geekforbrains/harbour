import { NextResponse } from "next/server";
import { serializeAttachment } from "@/lib/attachments-serialize";
import { type AuthContext, withRunExecutorOrUser } from "@/lib/auth";
import {
  createEmbedAttachment,
  createFileAttachment,
  detectEmbedProvider,
  getRunById,
  listAttachmentsByRun,
  type RunAttachment,
  type Uploader,
} from "@/lib/db/queries";
import { isVideoAutoProcessEnabled } from "@/lib/db/settings";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";
import { publicBaseUrl } from "@/lib/request-url";
import { receiveMultipartUploads, UploadError } from "@/lib/upload";
import { isVideoFile, processVideoAttachment } from "@/lib/video-processing";

export const runtime = "nodejs";

function uploaderFromAuth(auth: AuthContext): Uploader {
  if (auth.type === "user") return { type: "user", id: auth.userId, name: auth.displayName };
  if (auth.type === "executor")
    return { type: "agent", id: auth.agentId ?? auth.runId, name: auth.agentName ?? "Runner" };
  return { type: "agent", id: auth.agentId, name: auth.agentName };
}

export const GET = withRunExecutorOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const rows = listAttachmentsByRun(id);
    const base = publicBaseUrl(req);
    return NextResponse.json(rows.map((r) => serializeAttachment(r, base)));
  },
  { role: "viewer" },
);

export const POST = withRunExecutorOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const contentType = req.headers.get("content-type") || "";
    const uploader = uploaderFromAuth(auth);
    const base = publicBaseUrl(req);

    // Embed (URL) — JSON body
    if (contentType.toLowerCase().startsWith("application/json")) {
      const body = await readJson(req);
      const url = requireNonEmptyString(body.url, "url");
      const title = optionalString(body.title, "title");
      if (!detectEmbedProvider(url)) {
        return NextResponse.json({ error: "Invalid embed URL" }, { status: 400 });
      }
      const att = createEmbedAttachment({
        runId: id,
        url,
        title: title ?? null,
        uploader,
      });
      return NextResponse.json(serializeAttachment(att, base), { status: 201 });
    }

    // File upload — multipart/form-data
    try {
      const { files } = await receiveMultipartUploads(req, id);
      const created: RunAttachment[] = files.map((f) =>
        createFileAttachment({
          runId: id,
          filename: f.filename,
          storagePath: f.storagePath,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          uploader,
        }),
      );

      if (isVideoAutoProcessEnabled()) {
        for (const att of created) {
          if (isVideoFile(att.mime_type, att.filename)) {
            processVideoAttachment(att.id, id);
          }
        }
      }

      return NextResponse.json(
        created.map((r) => serializeAttachment(r, base)),
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof UploadError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error("[attachments POST] upload failed:", err);
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  },
  { role: "editor" },
);
