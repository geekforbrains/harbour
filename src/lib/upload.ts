import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import { ensureDir, maxUploadBytes, runUploadsDir, uploadsDir } from "./paths";

/**
 * Sanitize an uploaded filename. Keep the extension, strip path separators,
 * replace anything that isn't [a-z0-9._-] with underscores, and truncate.
 */
export function sanitizeFilename(input: string): string {
  const base = path.basename(input || "file");
  const ext = path
    .extname(base)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  const stem =
    base
      .slice(0, base.length - path.extname(base).length)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "")
      .slice(0, 80) || "file";
  return stem + ext;
}

/**
 * MIME types safe to render inline in the dashboard origin. The stored type is
 * client-declared (attacker-controlled), so this is a strict allowlist:
 * script-capable types (HTML, SVG, anything XML) must never be inline.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
]);

export function isInlineSafe(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const type = mime.split(";")[0].trim().toLowerCase();
  // Belt-and-braces: XML can carry script even if the allowlist ever grows.
  if (type.endsWith("+xml") || type === "text/xml" || type === "application/xml") return false;
  return INLINE_SAFE_TYPES.has(type);
}

/**
 * Build an RFC 6266/5987 Content-Disposition header value: an ASCII-safe
 * quoted fallback plus filename* carrying the real (UTF-8, percent-encoded)
 * name. No stored filename can inject headers — control chars are stripped
 * from the fallback and percent-encoding covers everything else.
 */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters from filenames to prevent header injection
  const name = (filename || "file").replace(/[\x00-\x1f\x7f]/g, "");
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "file";
  // encodeURIComponent leaves !'()*~ bare; ' ( ) * are not RFC 5987 attr-chars
  const encoded = (encodeURIComponent(name) || "file").replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export type StagedUpload = {
  filename: string; // original filename (sanitized)
  mimeType: string;
  sizeBytes: number;
  storagePath: string; // relative to uploadsDir()
};

/**
 * Stream a multipart/form-data request into per-run upload directory.
 *
 * Writes each file to a temp path first, then atomically renames into
 * place. On any error (size cap, stream fault), cleans up all temp files
 * before throwing.
 *
 * Enforces maxUploadBytes() per file.
 *
 * Returns staged file info + any non-file form fields.
 */
export async function receiveMultipartUploads(
  req: NextRequest,
  runId: string,
): Promise<{ files: StagedUpload[]; fields: Record<string, string> }> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new UploadError("Expected multipart/form-data", 400);
  }
  if (!req.body) {
    throw new UploadError("Empty request body", 400);
  }

  const destDir = runUploadsDir(runId);
  ensureDir(destDir);
  const limit = maxUploadBytes();

  const staged: StagedUpload[] = [];
  const tempPaths: string[] = [];
  const fields: Record<string, string> = {};
  const filePromises: Promise<void>[] = [];
  let firstError: Error | null = null;

  // Web ReadableStream → Node Readable for busboy
  const nodeStream = Readable.fromWeb(
    req.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );

  const bb = Busboy({
    headers: { "content-type": contentType },
    limits: { fileSize: limit },
  });

  const parserDone = new Promise<void>((resolve, reject) => {
    bb.on("file", (_fieldname, fileStream, info) => {
      const origName = sanitizeFilename(info.filename || "file");
      const storageName = `${uuid()}__${origName}`;
      const tempPath = path.join(destDir, `.${storageName}.tmp`);
      tempPaths.push(tempPath);

      const ws = fs.createWriteStream(tempPath);
      let size = 0;
      let exceeded = false;

      fileStream.on("data", (chunk) => {
        size += chunk.length;
      });

      fileStream.on("limit", () => {
        exceeded = true;
        if (!firstError)
          firstError = new UploadError(
            `File exceeds max upload size of ${Math.round(limit / 1024 / 1024)} MB`,
            413,
          );
      });

      filePromises.push(
        pipeline(fileStream, ws)
          .then(() => {
            if (exceeded) return;
            staged.push({
              filename: origName,
              mimeType: info.mimeType || "application/octet-stream",
              sizeBytes: size,
              storagePath: path.relative(uploadsDir(), path.join(destDir, storageName)),
            });
          })
          .catch((err) => {
            if (!firstError) firstError = err as Error;
          }),
      );
    });

    bb.on("field", (name, val) => {
      if (typeof val === "string") fields[name] = val;
    });

    bb.on("error", (err) => {
      if (!firstError) firstError = err as Error;
      reject(firstError);
    });

    bb.on("close", () => resolve());
  });

  try {
    nodeStream.pipe(bb);
    await parserDone;
    await Promise.all(filePromises);
    if (firstError) throw firstError;
  } catch (err) {
    await cleanupTempFiles(tempPaths);
    throw err;
  }

  // Rename temp files into final place
  try {
    for (const s of staged) {
      const tempName = `.${path.basename(s.storagePath)}.tmp`;
      const src = path.join(destDir, tempName);
      const dst = path.join(destDir, path.basename(s.storagePath));
      fs.renameSync(src, dst);
    }
  } catch (err) {
    await cleanupTempFiles(tempPaths);
    // Also clean any already-renamed finals
    for (const s of staged) {
      try {
        fs.unlinkSync(path.join(uploadsDir(), s.storagePath));
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return { files: staged, fields };
}

async function cleanupTempFiles(paths: string[]) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export class UploadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
