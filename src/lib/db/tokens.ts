import { createHash } from "node:crypto";

/** Hash a raw secret (runner token, exec token, API key, set-password token)
 * for storage / lookup. Only the SHA-256 hash is ever persisted. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
