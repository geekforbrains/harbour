import { ApiError } from "@/lib/api/client";

/**
 * Friendly message from a thrown mutation error: the server's `{ error }`
 * string when the failure was an API response (e.g. a 409 name collision),
 * otherwise the caller's fallback. Network-level errors carry technical
 * messages not meant for users, so they fall back too.
 */
export function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.errorMessage;
  return fallback;
}
