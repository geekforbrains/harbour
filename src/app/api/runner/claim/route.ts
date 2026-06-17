import { type NextRequest, NextResponse } from "next/server";
import { type SerializedAttachment, serializeAttachment } from "@/lib/attachments-serialize";
import { type RunnerAuth, withRunnerAuth } from "@/lib/auth";
import {
  claimNextRun,
  getProcessingByAttachment,
  peekClaim,
  type RunAttachment,
  touchRunnerPolled,
} from "@/lib/db/queries";
import type { RunnerCapabilities } from "@/lib/db/runners";
import { readJson } from "@/lib/http";
import { publicBaseUrl } from "@/lib/request-url";
import {
  isVideoFile,
  readStoryboard,
  readTranscript,
  TRANSCRIPT_CAP,
} from "@/lib/video-processing";

/**
 * The per-run `api` block. Endpoints are pre-resolved for this run; the runner
 * (and the CLI it spawns) authenticate every call below with the run's
 * `exec_token` (returned alongside this block), never the runner token.
 */
function buildApiSection(req: NextRequest, runId: string) {
  const base = publicBaseUrl(req);
  return {
    base_url: base,
    auth: "Bearer <exec_token> (from this claim) on every endpoint below — the /api/runs/:id/* lifecycle calls and the docs/tables endpoints",
    endpoints: {
      set_title: `PUT ${base}/api/runs/${runId}/title`,
      update_status: `PUT ${base}/api/runs/${runId}/status`,
      post_activity: `POST ${base}/api/runs/${runId}/activity`,
      post_output: `POST ${base}/api/runs/${runId}/output`,
      poll_kill: `GET ${base}/api/runs/${runId}/kill`,
      save_session: `PUT ${base}/api/runs/${runId}/session`,
      upload_attachment: `POST ${base}/api/runs/${runId}/attachments`,
      create_doc: `POST ${base}/api/docs`,
      update_doc: `PUT ${base}/api/docs/:id`,
      create_table: `POST ${base}/api/tables`,
      insert_rows: `POST ${base}/api/tables/:id/rows`,
      read_rows: `GET ${base}/api/tables/:id/rows`,
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

/** Validate the capabilities a runner advertises on every claim. */
function parseCapabilities(body: Record<string, unknown>): RunnerCapabilities | null {
  const caps = body.capabilities;
  if (!caps || typeof caps !== "object") return null;
  const c = caps as Record<string, unknown>;
  const arr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  const kinds = arr(c.kinds);
  const clis = arr(c.clis ?? []);
  const labels = arr(c.labels);
  if (!kinds || !clis || !labels) return null;
  return { kinds, clis, labels };
}

/**
 * The unified claim — the one execution entry point. A runner POSTs its
 * capabilities; the server hands back the next claimable run (kind-tagged, with
 * its exec token and a pre-resolved `api` block) or `{ run: null }`. `?peek=true`
 * proves liveness and reports availability without claiming.
 */
export const POST = withRunnerAuth(async (req, auth: RunnerAuth) => {
  const body = await readJson(req);
  const capabilities = parseCapabilities(body);
  if (!capabilities) {
    return NextResponse.json(
      { error: "capabilities { kinds: string[], clis: string[], labels: string[] } required" },
      { status: 400 },
    );
  }

  // Every claim/peek proves liveness and records advertised capabilities.
  touchRunnerPolled(auth.runnerId, capabilities);

  const runner = {
    id: auth.runnerId,
    tier: auth.tier,
    labels: auth.labels,
    scope: auth.scope,
  };

  if (req.nextUrl.searchParams.get("peek") === "true") {
    return NextResponse.json(peekClaim(runner, capabilities));
  }

  const payload = claimNextRun(runner, capabilities);
  if (!payload) return NextResponse.json({ run: null });

  const base = publicBaseUrl(req);
  const serialized = (payload.attachments as RunAttachment[]).map((a) =>
    serializeAttachment(a, base),
  );
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
      if (proc.screenshots_dir) {
        const storyboard = readStoryboard(proc.screenshots_dir, base, TRANSCRIPT_CAP);
        if (storyboard) processing.storyboard = storyboard;
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
