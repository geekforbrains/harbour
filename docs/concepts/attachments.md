# Attachments

An attachment is a file uploaded to — or a video URL embedded against — a single run. Two kinds: files on disk, and embedded video URLs auto-detected as YouTube / Loom / Vimeo.

## The mental model

The `run_attachments` table holds one row per attachment, owned by a run via `run_id`:

```sql
CREATE TABLE run_attachments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  activity_id TEXT REFERENCES run_activity(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','embed')),
  -- file kind:
  filename, storage_path, mime_type, size_bytes,
  -- embed kind:
  url, embed_provider,
  -- both:
  title, uploaded_by_*,
  created_at
);
```

There are two **kinds**:

| Kind | Storage | What you see |
|---|---|---|
| `file` | Bytes on disk under `~/.harbour/uploads/runs/<run-id>/<uuid>__<filename>`. Row carries `filename`, `storage_path` (relative to the uploads dir), `mime_type`, `size_bytes`. | Inline preview for images/video, a download link for everything else. |
| `embed` | Just a URL. Provider auto-detected — `youtube`, `loom`, `vimeo`, or `generic`. Row carries `url` and `embed_provider`. | An iframe for the three known providers, a plain link for `generic`. |

A worked example: the agent finishes a run, uploads a Loom recording of the output. `POST /api/runs/<run-id>/attachments` with `Content-Type: application/json` and body `{"url": "https://loom.com/..."}`. Provider gets detected as `loom`, an embed row is created, the dashboard renders it as a Loom iframe inside the run's attachment panel.

## File storage

Files land under `~/.harbour/uploads/runs/<run-id>/` (or under `HARBOUR_UPLOADS_DIR` if overridden):

```
~/.harbour/uploads/
  runs/
    <run-id>/
      <uuid>__sanitized-name.png
      processed/<attachment-id>/...   ← video processing artifacts
```

A UUID prefix in the storage filename keeps two uploads with the same original name from colliding. The original (sanitized) name is stored separately in the row's `filename` column for display.

When a run is deleted (and the run-cascade paths from job/agent deletion) the attachment rows cascade-delete via the FK and `deleteRunAttachmentsDir(runId)` wipes the on-disk directory.

## Upload protocol

`POST /api/runs/:id/attachments` accepts two content types:

- `application/json` — embed kind. Body `{ "url": "...", "title": "..." }`. Returns `201` with the serialized attachment.
- `multipart/form-data` — file kind. Streamed by Busboy.

For multipart uploads (`src/lib/upload.ts`):

1. Stream each `file` part into a temp path under the run's directory: `.<uuid>__<sanitized>.tmp`.
2. Track size as bytes flow. If a single file exceeds `HARBOUR_MAX_UPLOAD_MB` (default **500MB**, settable via env), busboy fires `limit`; the request short-circuits with `413`.
3. After the stream closes successfully, `fs.renameSync` each temp file to its final path. The temp-then-rename gives atomicity — readers never see a half-written file.
4. On any error (size cap, stream fault, write failure), `cleanupTempFiles` unlinks every temp path and any already-renamed finals before throwing. Partial uploads don't pollute the disk.

Returned to the caller is `[ SerializedAttachment, ... ]` — one entry per file in the form, plus an absolute download URL (for files), and the `embed_provider` (for embeds). `storage_path` is intentionally not serialized — clients have no business knowing the on-disk layout.

## Browser client

`src/lib/upload-client.ts` exposes `uploadFileToRun(runId, file, onProgress?)` returning `{ promise, abort }`. It uses `XMLHttpRequest` rather than `fetch` because Fetch doesn't expose upload progress events.

```ts
const handle = uploadFileToRun(runId, file, pct => setPct(pct));
// later
handle.abort();
const result = await handle.promise; // SerializedAttachment
```

For embeds: a plain `fetch` POST with JSON body.

## Auth

The agent that owns the run (via `requireAgentOwnership`) can upload, as can any signed-in dashboard user. This matches the broader model: agents only manipulate runs they're actively working on; the dashboard user is privileged.

## Endpoints

```
POST   /api/runs/:id/attachments                — upload file (multipart) or create embed (JSON)
GET    /api/runs/:id/attachments                — list (returns SerializedAttachment[])
DELETE /api/runs/:id/attachments/:aid           — delete row + on-disk file
GET    /api/runs/:id/attachments/:aid/file      — download a file attachment
```

## Video processing pipeline

Video files attached to runs can be auto-processed into a transcript + screenshot storyboard so an agent gets a usable summary in `/next` instead of a multi-megabyte binary.

It's opt-in: `video_auto_process` setting must be `"true"`. When enabled, every uploaded file whose mime type starts with `video/` (or matches a known video extension) kicks off `processVideoAttachment(attachmentId, runId)` fire-and-forget.

State machine in `attachment_processing`:

```
queued → processing → done
                    → failed
```

The pipeline:

1. **ffprobe** to read duration.
2. **ffmpeg** at `fps=1/<interval>` (default 5s, `video_screenshot_interval` setting) writing JPEGs into `~/.harbour/uploads/runs/<run-id>/processed/<attachment-id>/screenshots/`. Capped at 500 frames as a safety belt.
3. **ffmpeg** strips the audio to MP3.
4. **Transcript** via the configured provider — `whisper` (local CLI), `openai` (Whisper API), `gemini` (Gemini 2.0 Flash), or `off`. Returns timestamped segments.
5. **Storyboard** assembly — interleaved `[Screenshot N — MM:SS — <url>]` markers with the matching transcript snippet for each window.
6. Status flips to `done`. Transcript path and screenshot count get written back to the row.

When an agent polls `/next`, the route enriches each video attachment with a `processing` block — status, screenshot URL prefix, duration, and an inline transcript or storyboard capped at `TRANSCRIPT_CAP` (5000 chars). Anything larger needs a separate fetch via the screenshots/transcript endpoints.

If `ffmpeg` isn't on the PATH, the pipeline records a system activity message on the run ("Video processing skipped — ffmpeg not found") and exits cleanly. The video remains accessible as the original file.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/attachments.ts` — `createFileAttachment` / `createEmbedAttachment`, `detectEmbedProvider`, `deleteRunAttachmentsDir`.
- `src/lib/upload.ts` — Busboy multipart streaming, `sanitizeFilename`, the temp-then-rename atomicity, `UploadError` with status codes.
- `src/lib/upload-client.ts` — `uploadFileToRun`, `createEmbedAttachment`, `deleteAttachment`, `attachmentsUrlFor`.
- `src/lib/attachments-serialize.ts` — `SerializedAttachment` and how the file URL is built.
- `src/lib/paths.ts` — `runUploadsDir`, `maxUploadMb` (default 500), `processedDir`.
- `src/lib/video-processing.ts` — the ffprobe/ffmpeg/whisper pipeline, storyboard generation, `readStoryboard`/`readTranscript` for `/next` injection.
- `src/lib/db/schema.ts` — the `run_attachments` and `attachment_processing` tables.
