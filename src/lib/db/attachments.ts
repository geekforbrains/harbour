import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { runUploadsDir, uploadsDir } from "../paths";
import { getDb } from "./schema";

export type AttachmentKind = "file" | "embed";

export type RunAttachment = {
  id: string;
  run_id: string;
  activity_id: string | null;
  kind: AttachmentKind;
  filename: string | null;
  storage_path: string | null; // relative to uploadsDir()
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  embed_provider: string | null;
  title: string | null;
  uploaded_by_type: "user" | "agent" | null;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  created_at: number;
};

export type Uploader = {
  type: "user" | "agent";
  id: string | null;
  name: string;
};

/**
 * Detect a video embed provider from a URL.
 * Returns null for URLs we don't render as iframes.
 */
export function detectEmbedProvider(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return "youtube";
    if (host === "loom.com" || host.endsWith(".loom.com")) return "loom";
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return "vimeo";
    return "generic";
  } catch {
    return null;
  }
}

export function createFileAttachment(params: {
  runId: string;
  filename: string;
  storagePath: string; // relative to uploadsDir()
  mimeType: string;
  sizeBytes: number;
  uploader: Uploader;
  title?: string | null;
}): RunAttachment {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO run_attachments
      (id, run_id, kind, filename, storage_path, mime_type, size_bytes, title,
       uploaded_by_type, uploaded_by_id, uploaded_by_name)
    VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.runId,
    params.filename,
    params.storagePath,
    params.mimeType,
    params.sizeBytes,
    params.title ?? null,
    params.uploader.type,
    params.uploader.id,
    params.uploader.name,
  );
  return getAttachmentById(id)!;
}

export function createEmbedAttachment(params: {
  runId: string;
  url: string;
  uploader: Uploader;
  title?: string | null;
}): RunAttachment {
  const db = getDb();
  const provider = detectEmbedProvider(params.url);
  if (!provider) throw new Error("Invalid embed URL");
  const id = uuid();
  db.prepare(`
    INSERT INTO run_attachments
      (id, run_id, kind, url, embed_provider, title,
       uploaded_by_type, uploaded_by_id, uploaded_by_name)
    VALUES (?, ?, 'embed', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.runId,
    params.url,
    provider,
    params.title ?? null,
    params.uploader.type,
    params.uploader.id,
    params.uploader.name,
  );
  return getAttachmentById(id)!;
}

export function getAttachmentById(id: string): RunAttachment | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM run_attachments WHERE id = ?`).get(id) as
    | RunAttachment
    | undefined;
  return row || null;
}

export function listAttachmentsByRun(runId: string): RunAttachment[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM run_attachments WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as RunAttachment[];
}

/**
 * Link a set of attachments (by id) to a newly-created activity entry.
 * Used when a comment is posted with previously-uploaded attachments.
 */
export function linkAttachmentsToActivity(
  attachmentIds: string[],
  activityId: string,
  runId: string,
): void {
  if (!attachmentIds.length) return;
  const db = getDb();
  const placeholders = attachmentIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE run_attachments SET activity_id = ? WHERE run_id = ? AND id IN (${placeholders}) AND activity_id IS NULL`,
  ).run(activityId, runId, ...attachmentIds);
}

/**
 * Delete an attachment row + its on-disk file (if any).
 */
export function deleteAttachment(id: string): boolean {
  const db = getDb();
  const att = getAttachmentById(id);
  if (!att) return false;
  if (att.kind === "file" && att.storage_path) {
    const abs = path.join(uploadsDir(), att.storage_path);
    try {
      fs.unlinkSync(abs);
    } catch {
      /* file already gone — ignore */
    }
  }
  db.prepare(`DELETE FROM run_attachments WHERE id = ?`).run(id);
  return true;
}

/**
 * Remove the on-disk directory for a run's attachments. The DB rows
 * cascade-delete via the FK; this just cleans up the filesystem side.
 */
export function deleteRunAttachmentsDir(runId: string): void {
  const dir = runUploadsDir(runId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
