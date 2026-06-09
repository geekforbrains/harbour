import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth, requireAgentSelf } from "@/lib/auth";
import { getAgentById, touchAgentPolled, getAgentNextRun, peekAgentNext, RunAttachment, getProcessingByAttachment } from "@/lib/db/queries";
import { serializeAttachment, SerializedAttachment } from "@/lib/attachments-serialize";
import { publicBaseUrl } from "@/lib/request-url";
import { isVideoFile, readTranscript, readStoryboard, TRANSCRIPT_CAP } from "@/lib/video-processing";

function buildApiSection(req: NextRequest, runId: string) {
  const base = publicBaseUrl(req);
  return {
    base_url: base,
    endpoints: {
      set_title: `PUT ${base}/api/runs/${runId}/title`,
      update_status: `PUT ${base}/api/runs/${runId}/status`,
      post_activity: `POST ${base}/api/runs/${runId}/activity`,
      upload_attachment: `POST ${base}/api/runs/${runId}/attachments`,
      create_doc: `POST ${base}/api/docs`,
      update_doc: `PUT ${base}/api/docs/:id`,
      create_database: `POST ${base}/api/databases`,
      insert_rows: `POST ${base}/api/databases/:id/rows`,
      read_rows: `GET ${base}/api/databases/:id/rows`,
      guide: `GET ${base}/api/guide`,
    },
    status_options: ["done", "failed", "waiting"],
    notes: [
      "Set a short run title via set_title before doing anything else — this is how humans identify the run on the dashboard.",
      "Set status to waiting if you need human input to continue (the run pauses until a human replies). The harness drives a dedicated finalize turn after your work, so you don't need to remember to set done/failed at the end.",
      "Post activity messages to log progress — these are visible on the dashboard.",
      "Attachments belong to the run thread — files (multipart) or video URL embeds (JSON {url}).",
      "Full API spec available at the guide endpoint.",
    ],
  };
}

export const GET = withAgentAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const ownerError = requireAgentSelf(auth, id);
  if (ownerError) return ownerError;

  const existing = getAgentById(id);
  if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  touchAgentPolled(id);

  const peek = req.nextUrl.searchParams.get("peek") === "true";
  if (peek) {
    const result = peekAgentNext(id);
    return NextResponse.json(result);
  }

  const payload = getAgentNextRun(id);
  if (!payload) {
    return NextResponse.json(null);
  }

  const base = publicBaseUrl(req);
  const serialized = (payload.attachments as RunAttachment[]).map(a => serializeAttachment(a, base));

  const enriched = serialized.map((att: SerializedAttachment) => {
    if (!isVideoFile(att.mime_type, att.filename)) return att;
    const proc = getProcessingByAttachment(att.id);
    if (!proc) return att;

    const processing: Record<string, unknown> = {
      status: proc.status,
      screenshot_count: proc.screenshot_count,
      screenshots_url: `${base}/api/runs/${payload.run.id}/attachments/${att.id}/screenshots`,
      duration_seconds: proc.duration_seconds,
    };

    if (proc.status === "done") {
      // Prefer storyboard (interleaved screenshots + transcript) over plain transcript
      if (proc.screenshots_dir) {
        const storyboard = readStoryboard(proc.screenshots_dir, base, TRANSCRIPT_CAP);
        if (storyboard) {
          processing.storyboard = storyboard;
        }
      }
      if (proc.transcript_path) {
        processing.transcript = readTranscript(proc.transcript_path, TRANSCRIPT_CAP);
        processing.transcript_url = `${base}/api/runs/${payload.run.id}/attachments/${att.id}/transcript`;
      }
    }

    return { ...att, processing };
  });

  return NextResponse.json({
    ...payload,
    attachments: enriched,
    api: buildApiSection(req, payload.run.id),
  });
});
