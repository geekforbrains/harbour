"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  FileIcon,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Video,
  X,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { SerializedAttachment } from "@/lib/attachments-serialize";
import {
  createEmbedAttachment,
  deleteAttachment,
  detectEmbedProvider,
  type UploadHandle,
  uploadFileToRun,
} from "@/lib/upload-client";
import { cn } from "@/lib/utils";

type PendingStatus = "uploading" | "done" | "error";

type Pending = {
  localId: string;
  kind: "file" | "embed";
  name: string;
  size?: number;
  mime?: string;
  status: PendingStatus;
  progress: number;
  error?: string;
  attachment?: SerializedAttachment;
  handle?: UploadHandle;
};

export type AttachmentComposerHandle = {
  /** Collect successfully-uploaded attachment IDs, then clear. */
  drain: () => string[];
  /** Delete any pending server-side attachments (e.g. on navigation). */
  discardAll: () => Promise<void>;
  /** Add an embed URL programmatically (e.g. from paste handler). */
  addEmbedUrl: (url: string) => void;
  /** Accept dropped/selected files. */
  addFiles: (files: FileList | File[]) => void;
};

type Props = {
  runId: string;
  className?: string;
  /**
   * Called whenever the set of successfully-uploaded (but not yet submitted)
   * attachment IDs changes. The parent can use this to filter those rows out
   * of the "standalone attachments" section while they're still staged in
   * the composer — otherwise they briefly appear in both places.
   */
  onStagedIdsChange?: (ids: string[]) => void;
};

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(mime: string | undefined) {
  if (!mime) return FileIcon;
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.startsWith("video/")) return Video;
  return FileIcon;
}

export const AttachmentComposer = forwardRef<AttachmentComposerHandle, Props>(
  function AttachmentComposer({ runId, className, onStagedIdsChange }, ref) {
    const [pending, setPending] = useState<Pending[]>([]);
    const pendingRef = useRef<Pending[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Keep ref in sync for imperative methods
    useEffect(() => {
      pendingRef.current = pending;
    }, [pending]);

    // Notify parent of currently-staged (done, not yet submitted) attachment IDs
    useEffect(() => {
      if (!onStagedIdsChange) return;
      const ids = pending
        .filter((p) => p.status === "done" && p.attachment)
        .map((p) => p.attachment!.id);
      onStagedIdsChange(ids);
    }, [pending, onStagedIdsChange]);

    const { data: config } = useQuery<{ max_upload_mb: number; max_upload_bytes: number }>({
      queryKey: ["upload-config"],
      queryFn: () =>
        apiFetch<{ max_upload_mb: number; max_upload_bytes: number }>("/api/system/upload-config"),
      staleTime: 60_000,
    });
    const maxBytes = config?.max_upload_bytes;
    const maxMb = config?.max_upload_mb;

    const update = useCallback((localId: string, patch: Partial<Pending>) => {
      setPending((prev) => prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));
    }, []);

    const remove = useCallback((localId: string) => {
      setPending((prev) => prev.filter((p) => p.localId !== localId));
    }, []);

    const addFiles = useCallback(
      (input: FileList | File[]) => {
        const files = Array.from(input);
        for (const file of files) {
          const localId = crypto.randomUUID();

          if (maxBytes && file.size > maxBytes) {
            setPending((prev) => [
              ...prev,
              {
                localId,
                kind: "file",
                name: file.name,
                size: file.size,
                mime: file.type,
                status: "error",
                progress: 0,
                error: `Exceeds ${maxMb} MB limit`,
              },
            ]);
            continue;
          }

          const handle = uploadFileToRun(runId, file, (pct) => {
            update(localId, { progress: pct });
          });

          setPending((prev) => [
            ...prev,
            {
              localId,
              kind: "file",
              name: file.name,
              size: file.size,
              mime: file.type,
              status: "uploading",
              progress: 0,
              handle,
            },
          ]);

          handle.promise
            .then((att) =>
              update(localId, {
                status: "done",
                progress: 100,
                attachment: att,
                handle: undefined,
              }),
            )
            .catch((err) =>
              update(localId, {
                status: "error",
                error: err.message || String(err),
                handle: undefined,
              }),
            );
        }
      },
      [runId, maxBytes, maxMb, update],
    );

    const addEmbedUrl = useCallback(
      (url: string) => {
        const provider = detectEmbedProvider(url);
        if (!provider) return;
        const localId = crypto.randomUUID();
        setPending((prev) => [
          ...prev,
          {
            localId,
            kind: "embed",
            name: url,
            status: "uploading",
            progress: 0,
          },
        ]);
        createEmbedAttachment(runId, url)
          .then((att) =>
            update(localId, {
              status: "done",
              progress: 100,
              attachment: att,
              name: att.title || url,
              mime: `video/${provider}`,
            }),
          )
          .catch((err) => update(localId, { status: "error", error: err.message || String(err) }));
      },
      [runId, update],
    );

    const handleRemove = useCallback(
      async (p: Pending) => {
        if (p.status === "uploading" && p.handle) {
          p.handle.abort();
        }
        if (p.attachment) {
          try {
            await deleteAttachment(runId, p.attachment.id);
          } catch {
            /* ignore */
          }
        }
        remove(p.localId);
      },
      [runId, remove],
    );

    useImperativeHandle(
      ref,
      () => ({
        drain: () => {
          const ids = pendingRef.current
            .filter((p) => p.status === "done" && p.attachment)
            .map((p) => p.attachment!.id);
          setPending((prev) => prev.filter((p) => p.status !== "done"));
          return ids;
        },
        discardAll: async () => {
          const items = pendingRef.current;
          for (const p of items) {
            if (p.status === "uploading" && p.handle) p.handle.abort();
            if (p.attachment) {
              try {
                await deleteAttachment(runId, p.attachment.id);
              } catch {
                /* ignore */
              }
            }
          }
          setPending([]);
        },
        addEmbedUrl,
        addFiles,
      }),
      [runId, addEmbedUrl, addFiles],
    );

    return (
      <div className={className}>
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pending.map((p) => {
              const Icon = iconFor(p.mime);
              return (
                <div
                  key={p.localId}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs max-w-xs",
                    p.status === "error" && "border-destructive/50 bg-destructive/5",
                  )}
                >
                  {p.status === "uploading" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-muted-foreground" />
                  ) : p.status === "error" ? (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : (
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    {p.status === "uploading" && (
                      <div className="h-1 mt-0.5 rounded bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${p.progress}%` }}
                        />
                      </div>
                    )}
                    {p.status === "done" && p.size && (
                      <div className="text-muted-foreground">{formatSize(p.size)}</div>
                    )}
                    {p.status === "error" && <div className="text-destructive">{p.error}</div>}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleRemove(p)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label className="relative inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer">
            <Paperclip className="h-3.5 w-3.5" />
            Attach
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {maxMb && (
            <span>Max {maxMb} MB. Drag files, paste images, or paste Loom/YouTube/Vimeo URLs.</span>
          )}
        </div>
      </div>
    );
  },
);
