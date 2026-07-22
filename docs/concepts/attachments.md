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
| `file` | Bytes on disk under `~/.harbour/uploads/runs/<run-id>/<uuid>__<filename>`. Row carries `filename`, `storage_path` (relative to the uploads dir), `mime_type`, `size_bytes`. | Inline preview for types on a strict allowlist (raster images, PDF, plain text, common audio/video); everything else — including SVG and HTML, which can carry scripts — is forced to download. |
| `embed` | Just a URL. Provider auto-detected — `youtube`, `loom`, `vimeo`, or `generic`. Row carries `url` and `embed_provider`. | An iframe for the three known providers, a plain link for `generic`. |

A worked example: the agent finishes a run, uploads a Loom recording of the output. `POST /api/runs/<run-id>/attachments` with `Content-Type: application/json` and body `{"url": "https://loom.com/..."}`. Provider gets detected as `loom`, an embed row is created, the dashboard renders it as a Loom iframe inside the run's attachment panel.

## File storage

Files land under `~/.harbour/uploads/runs/<run-id>/` (or under `HARBOUR_UPLOADS_DIR` if overridden):

```
~/.harbour/uploads/
  runs/
    <run-id>/
      <uuid>__sanitized-name.png
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

Attachment routes use `withRunExecutorOrUser`: the run's per-run exec token — bound to exactly that run, so an executor can't reach another run's attachments — or any authenticated user acting from the dashboard. See the [auth model](../reference/architecture.md#auth-model).

## Endpoints

```
POST   /api/runs/:id/attachments                — upload file (multipart) or create embed (JSON)
GET    /api/runs/:id/attachments                — list (returns SerializedAttachment[])
DELETE /api/runs/:id/attachments/:aid           — delete row + on-disk file
GET    /api/runs/:id/attachments/:aid/file      — download a file attachment
```

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/attachments.ts` — `createFileAttachment` / `createEmbedAttachment`, `detectEmbedProvider`, `deleteRunAttachmentsDir`.
- `src/lib/upload.ts` — Busboy multipart streaming, `sanitizeFilename`, the temp-then-rename atomicity, `UploadError` with status codes.
- `src/lib/upload-client.ts` — `uploadFileToRun`, `createEmbedAttachment`, `deleteAttachment`, `attachmentsUrlFor`.
- `src/lib/attachments-serialize.ts` — `SerializedAttachment` and how the file URL is built.
- `src/lib/paths.ts` — `runUploadsDir` and `maxUploadMb` (default 500).
- `src/lib/db/schema.ts` — the `run_attachments` table.
