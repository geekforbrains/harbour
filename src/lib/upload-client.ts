/**
 * Browser-side upload helper. Uses XMLHttpRequest so we can report
 * progress — the Fetch API does not expose upload progress events.
 */

import type { SerializedAttachment } from "./attachments-serialize";

export type UploadProgress = (pct: number) => void;

export type UploadHandle = {
  promise: Promise<SerializedAttachment>;
  abort: () => void;
};

export function uploadFileToRun(
  runId: string,
  file: File,
  onProgress?: UploadProgress,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append("file", file);

  const promise = new Promise<SerializedAttachment>((resolve, reject) => {
    xhr.open("POST", `/api/runs/${runId}/attachments`, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const arr = JSON.parse(xhr.responseText);
          resolve(arr[0]);
        } catch (err) {
          reject(err);
        }
      } else {
        let message = `Upload failed (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
          /* ignore */
        }
        reject(new Error(message));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));

    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}

export async function createEmbedAttachment(
  runId: string,
  url: string,
  title?: string,
): Promise<SerializedAttachment> {
  const res = await fetch(`/api/runs/${runId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error(err.error || "Failed to add embed");
  }
  return res.json();
}

export async function deleteAttachment(runId: string, attachmentId: string): Promise<void> {
  await fetch(`/api/runs/${runId}/attachments/${attachmentId}`, { method: "DELETE" });
}

/** Match URLs we support embedding. Must stay in sync with server-side detectEmbedProvider. */
export function detectEmbedProvider(url: string): "youtube" | "loom" | "vimeo" | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return "youtube";
    if (host === "loom.com" || host.endsWith(".loom.com")) return "loom";
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return "vimeo";
    return null;
  } catch {
    return null;
  }
}
