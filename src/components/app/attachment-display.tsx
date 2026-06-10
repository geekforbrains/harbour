"use client";

import { Download, FileText, Video } from "lucide-react";
import type { SerializedAttachment } from "@/lib/attachments-serialize";

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function youtubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    let id: string | null = null;
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    else id = u.searchParams.get("v");
    return id ? `https://www.youtube.com/embed/${id}` : null;
  } catch {
    return null;
  }
}

function loomEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/share\/([a-zA-Z0-9]+)/);
    return m ? `https://www.loom.com/embed/${m[1]}` : null;
  } catch {
    return null;
  }
}

function vimeoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(\d+)/);
    return m ? `https://player.vimeo.com/video/${m[1]}` : null;
  } catch {
    return null;
  }
}

export function AttachmentDisplay({ att }: { att: SerializedAttachment }) {
  if (att.kind === "embed" && att.url) {
    const embed =
      att.embed_provider === "youtube"
        ? youtubeEmbedUrl(att.url)
        : att.embed_provider === "loom"
          ? loomEmbedUrl(att.url)
          : att.embed_provider === "vimeo"
            ? vimeoEmbedUrl(att.url)
            : null;

    if (embed) {
      return (
        <div className="rounded-lg border overflow-hidden bg-muted max-w-xl">
          <div className="aspect-video">
            <iframe
              title={att.title || "Embedded video"}
              src={embed}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          {att.title && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-t">{att.title}</div>
          )}
        </div>
      );
    }

    // Generic link for unknown embed provider
    return (
      <a
        href={att.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted max-w-xl"
      >
        <Video className="h-4 w-4 shrink-0" />
        <span className="truncate">{att.title || att.url}</span>
      </a>
    );
  }

  // File attachments
  if (!att.url) return null;
  const mime = att.mime_type || "";

  if (mime.startsWith("image/")) {
    return (
      <a href={att.url} target="_blank" rel="noreferrer" className="block max-w-md">
        {/* biome-ignore lint/performance/noImgElement: dynamic user-uploaded attachment URLs served by our API; next/image optimization adds no value here */}
        <img
          src={att.url}
          alt={att.filename || "attachment"}
          className="rounded-lg border max-h-96 w-auto"
        />
      </a>
    );
  }

  if (mime.startsWith("video/")) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: run attachments are user-uploaded media with no caption tracks available
      <video controls className="rounded-lg border max-h-96 max-w-xl">
        <source src={att.url} type={mime} />
      </video>
    );
  }

  if (mime === "application/pdf") {
    return (
      <a
        href={att.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted max-w-xl"
      >
        <FileText className="h-4 w-4 shrink-0 text-red-500" />
        <span className="truncate flex-1">{att.filename}</span>
        <span className="text-xs text-muted-foreground shrink-0">{formatSize(att.size_bytes)}</span>
      </a>
    );
  }

  // Generic download chip
  return (
    <a
      href={att.url}
      target="_blank"
      rel="noreferrer"
      download={att.filename || undefined}
      className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted max-w-xl"
    >
      <Download className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1">{att.filename}</span>
      <span className="text-xs text-muted-foreground shrink-0">{formatSize(att.size_bytes)}</span>
    </a>
  );
}

export function AttachmentList({ items }: { items: SerializedAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {items.map((a) => (
        <AttachmentDisplay key={a.id} att={a} />
      ))}
    </div>
  );
}
