import { describe, expect, it } from "vitest";
import { contentDisposition, isInlineSafe } from "@/lib/upload";

// The attachment MIME type is client-declared at upload time and therefore
// attacker-controlled. Anything served inline runs in the dashboard origin, so
// the inline allowlist must be strict (no SVG, no HTML, no XML of any flavor)
// and the Content-Disposition header must be injection-proof regardless of the
// stored filename. These tests lock both helpers down.

describe("isInlineSafe", () => {
  it("allows raster image types", () => {
    expect(isInlineSafe("image/png")).toBe(true);
    expect(isInlineSafe("image/jpeg")).toBe(true);
    expect(isInlineSafe("image/gif")).toBe(true);
    expect(isInlineSafe("image/webp")).toBe(true);
    expect(isInlineSafe("image/avif")).toBe(true);
  });

  it("allows pdf and plain text", () => {
    expect(isInlineSafe("application/pdf")).toBe(true);
    expect(isInlineSafe("text/plain")).toBe(true);
  });

  it("allows common audio/video types", () => {
    expect(isInlineSafe("video/mp4")).toBe(true);
    expect(isInlineSafe("video/webm")).toBe(true);
    expect(isInlineSafe("audio/mpeg")).toBe(true);
    expect(isInlineSafe("audio/ogg")).toBe(true);
    expect(isInlineSafe("audio/wav")).toBe(true);
    expect(isInlineSafe("audio/mp4")).toBe(true);
  });

  it("rejects script-capable types that would XSS the dashboard origin", () => {
    expect(isInlineSafe("image/svg+xml")).toBe(false);
    expect(isInlineSafe("text/html")).toBe(false);
    expect(isInlineSafe("application/xhtml+xml")).toBe(false);
    expect(isInlineSafe("text/xml")).toBe(false);
    expect(isInlineSafe("application/xml")).toBe(false);
  });

  it("rejects any +xml suffix even under an allowed-looking prefix", () => {
    expect(isInlineSafe("image/png+xml")).toBe(false);
    expect(isInlineSafe("audio/mpeg+xml")).toBe(false);
    expect(isInlineSafe("application/rss+xml")).toBe(false);
  });

  it("rejects types not on the allowlist", () => {
    expect(isInlineSafe("application/javascript")).toBe(false);
    expect(isInlineSafe("text/css")).toBe(false);
    expect(isInlineSafe("text/csv")).toBe(false);
    expect(isInlineSafe("image/x-icon")).toBe(false);
    expect(isInlineSafe("application/octet-stream")).toBe(false);
  });

  it("rejects null/empty/garbage", () => {
    expect(isInlineSafe(null)).toBe(false);
    expect(isInlineSafe("")).toBe(false);
    expect(isInlineSafe("not-a-mime")).toBe(false);
  });

  it("normalizes case and ignores parameters", () => {
    expect(isInlineSafe("Image/PNG")).toBe(true);
    expect(isInlineSafe("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineSafe("TEXT/HTML; charset=utf-8")).toBe(false);
    expect(isInlineSafe("image/SVG+XML")).toBe(false);
  });

  it("does not let parameters smuggle a disallowed type past the check", () => {
    expect(isInlineSafe("text/html; fake=image/png")).toBe(false);
  });
});

describe("contentDisposition", () => {
  it("builds a simple ascii disposition with both filename forms", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(contentDisposition("inline", "photo.png")).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
    );
  });

  it("strips quotes and backslashes from the ascii fallback", () => {
    const header = contentDisposition("attachment", `a"b\\c.txt`);
    expect(header).toContain(`filename="abc.txt"`);
    const fallback = header.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(fallback).not.toMatch(/["\\]/);
  });

  it("never emits CR/LF or other control chars (header injection)", () => {
    const evil = "x.txt\r\nSet-Cookie: pwned=1\r\n\r\n<script>";
    const header = contentDisposition("attachment", evil);
    // CR/LF gone means the smuggled header text is inert value content
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test intentionally asserts control characters are stripped from the header
    expect(header).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
  });

  it("strips control characters embedded mid-filename", () => {
    const header = contentDisposition("inline", "a\x00b\x1fc\x7fd.png");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test intentionally asserts control characters are stripped from the header
    expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(header).toContain(`filename="abcd.png"`);
  });

  it("percent-encodes unicode in filename* and keeps fallback ascii-only", () => {
    const header = contentDisposition("attachment", "résumé — final.pdf");
    // filename* carries the real name, RFC 5987 percent-encoded
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%80%94%20final.pdf");
    // ascii fallback contains no non-ascii bytes
    const fallback = header.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(fallback).toMatch(/^[\x20-\x7e]*$/);
  });

  it("percent-encodes characters outside RFC 5987 attr-char", () => {
    const header = contentDisposition("attachment", "a'b(c)d*e.txt");
    expect(header).toContain("filename*=UTF-8''a%27b%28c%29d%2Ae.txt");
  });

  it("falls back to a usable name when the filename is empty or all-stripped", () => {
    expect(contentDisposition("attachment", "")).toContain(`filename="file"`);
    expect(contentDisposition("attachment", '"""')).toContain(`filename="file"`);
  });

  it("uses the requested disposition kind", () => {
    expect(contentDisposition("inline", "a.png").startsWith("inline; ")).toBe(true);
    expect(contentDisposition("attachment", "a.png").startsWith("attachment; ")).toBe(true);
  });
});
