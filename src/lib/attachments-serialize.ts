import type { RunAttachment } from "./db/attachments";

/**
 * Serialize a RunAttachment for the wire. Hides on-disk storage_path,
 * adds an absolute download URL for file kind, exposes embed metadata as-is.
 */
export type SerializedAttachment = {
  id: string;
  run_id: string;
  activity_id: string | null;
  kind: "file" | "embed";
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null; // file: download URL; embed: source URL
  embed_provider: string | null;
  title: string | null;
  uploaded_by_type: "user" | "agent" | null;
  uploaded_by_name: string | null;
  created_at: number;
};

export function serializeAttachment(att: RunAttachment, baseUrl: string): SerializedAttachment {
  const url =
    att.kind === "file" ? `${baseUrl}/api/runs/${att.run_id}/attachments/${att.id}/file` : att.url;
  return {
    id: att.id,
    run_id: att.run_id,
    activity_id: att.activity_id,
    kind: att.kind,
    filename: att.filename,
    mime_type: att.mime_type,
    size_bytes: att.size_bytes,
    url,
    embed_provider: att.embed_provider,
    title: att.title,
    uploaded_by_type: att.uploaded_by_type,
    uploaded_by_name: att.uploaded_by_name,
    created_at: att.created_at,
  };
}
