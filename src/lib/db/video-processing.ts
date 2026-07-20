import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

export type ProcessingStatus = "queued" | "processing" | "done" | "failed";

export type AttachmentProcessing = {
  id: string;
  attachment_id: string;
  run_id: string;
  status: ProcessingStatus;
  transcript_path: string | null;
  screenshots_dir: string | null;
  screenshot_count: number;
  screenshot_interval: number | null;
  duration_seconds: number | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
};

export function createProcessingRecord(
  attachmentId: string,
  runId: string,
  screenshotInterval: number,
): AttachmentProcessing {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO attachment_processing (id, attachment_id, run_id, status, screenshot_interval)
    VALUES (?, ?, ?, 'queued', ?)
  `).run(id, attachmentId, runId, screenshotInterval);
  return getProcessingByAttachment(attachmentId)!;
}

export function getProcessingByAttachment(attachmentId: string): AttachmentProcessing | null {
  const db = getDb();
  return (
    (db.prepare(`SELECT * FROM attachment_processing WHERE attachment_id = ?`).get(attachmentId) as
      | AttachmentProcessing
      | undefined) || null
  );
}

export function updateProcessingStatus(
  id: string,
  status: ProcessingStatus,
  extra?: {
    transcript_path?: string;
    screenshots_dir?: string;
    screenshot_count?: number;
    duration_seconds?: number;
    error?: string;
  },
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["status = ?"];
  const params: any[] = [status];

  if (status === "processing") {
    sets.push("started_at = ?");
    params.push(now);
  }
  if (status === "done" || status === "failed") {
    sets.push("completed_at = ?");
    params.push(now);
  }
  if (extra?.transcript_path !== undefined) {
    sets.push("transcript_path = ?");
    params.push(extra.transcript_path);
  }
  if (extra?.screenshots_dir !== undefined) {
    sets.push("screenshots_dir = ?");
    params.push(extra.screenshots_dir);
  }
  if (extra?.screenshot_count !== undefined) {
    sets.push("screenshot_count = ?");
    params.push(extra.screenshot_count);
  }
  if (extra?.duration_seconds !== undefined) {
    sets.push("duration_seconds = ?");
    params.push(extra.duration_seconds);
  }
  if (extra?.error !== undefined) {
    sets.push("error = ?");
    params.push(extra.error);
  }

  params.push(id);
  db.prepare(`UPDATE attachment_processing SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteProcessingRecord(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM attachment_processing WHERE id = ?`).run(id);
}
