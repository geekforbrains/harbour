import type { NextRequest } from "next/server";

/**
 * Build the public base URL from an incoming request.
 *
 * When Harbour sits behind a reverse proxy (Tailscale Serve, Cloudflare,
 * nginx, etc.) `req.nextUrl.host` reflects the internal upstream
 * (`127.0.0.1:4272`), not the user-facing hostname. That makes any
 * absolute URLs we bake into API responses — attachment download URLs,
 * agent endpoint URLs — unreachable from the user's browser.
 *
 * Respect `X-Forwarded-Host` / `X-Forwarded-Proto` when present, and
 * fall back to `req.nextUrl` otherwise. If multiple values are chained
 * (comma-separated), use the first (leftmost) entry — that's the
 * original client-facing host.
 */
export function publicBaseUrl(req: NextRequest): string {
  const fwdHost = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const fwdProto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = fwdHost || req.nextUrl.host;
  // nextUrl.protocol includes a trailing ":", header values do not
  const proto = fwdProto || req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}
