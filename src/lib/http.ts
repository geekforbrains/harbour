import { getProjectById } from "./db/projects";
import { DEFAULT_RUNTIME, type Gate, isRuntime, RUNTIMES } from "./runtimes";

// Request parsing + input validation helpers shared by API route handlers.
//
// The convention: a handler validates its input and either succeeds or rejects
// with a clear 4xx — it never 500s on a malformed body or silently persists a
// wrong-typed value. Validation helpers throw {@link HttpError}; every route
// runs inside an auth wrapper (src/lib/auth.ts) whose `runHandler` catches
// HttpError and renders it as `{ error }` with the right status. So a handler
// can just `const body = await readJson(req)` and call the `require*`/`optional*`
// guards without its own try/catch.

/** An error carrying an HTTP status. Caught centrally by the auth wrappers. */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Reject the request with a 400 and a clear message. */
export function badRequest(message: string): never {
  throw new HttpError(message, 400);
}

/**
 * Parse a JSON request body into a plain object. An empty body becomes `{}` (so
 * routes with only optional fields just work); malformed JSON or a non-object
 * top-level value (array, string, number, null) is a clean 400 instead of an
 * unhandled throw → 500.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError("Could not read request body");
  }
  if (!text || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError("Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Require a non-empty (after trim) string. Returns the trimmed value. */
export function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    badRequest(`${name} is required and must be a non-empty string`);
  }
  return (value as string).trim();
}

/**
 * A string field that may be omitted. `undefined`/`null` → `undefined`; any
 * present value must be a string (else 400). Not trimmed — callers that need a
 * non-empty value should use {@link requireNonEmptyString}.
 */
export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") badRequest(`${name} must be a string`);
  return value as string;
}

/** Require a strictly-positive integer. */
export function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    badRequest(`${name} must be a positive integer`);
  }
  return value as number;
}

/** An optional strictly-positive integer (omitted → undefined). */
export function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePositiveInt(value, name);
}

/**
 * Require a non-negative integer — zero allowed (a counter delta can be 0).
 * Safe integers only: Number.isInteger accepts integer-valued doubles like
 * 1e308, which better-sqlite3 would bind as REAL and silently degrade an
 * INTEGER counter column (two such adds overflow to Infinity → null in JSON).
 */
export function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    badRequest(`${name} must be a non-negative integer`);
  }
  return value as number;
}

/** An optional boolean (omitted → undefined; any present value must be boolean). */
export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") badRequest(`${name} must be a boolean`);
  return value;
}

/** An optional array of strings (omitted → undefined). */
export function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    badRequest(`${name} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Validate a job gate: `{ runtime?, content }`. `content` is required and must
 * be a non-empty string (stored verbatim — never trimmed, so shebangs and
 * leading blank lines survive). `runtime` is optional and defaults to
 * {@link DEFAULT_RUNTIME}; when present it must be a supported runtime. Throws a
 * 400 (via the auth wrapper) on anything malformed.
 */
export function parseGate(value: unknown, name: string): Gate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    badRequest(`${name} must be an object with a runtime and content`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.content !== "string" || obj.content.trim() === "") {
    badRequest(`${name}.content is required and must be a non-empty string`);
  }
  let runtime = DEFAULT_RUNTIME;
  if (obj.runtime !== undefined && obj.runtime !== null) {
    if (!isRuntime(obj.runtime)) {
      badRequest(`${name}.runtime must be one of: ${RUNTIMES.join(", ")}`);
    }
    runtime = obj.runtime;
  }
  return { runtime, content: obj.content };
}

/** A required gate (missing/null → 400). */
export function requireGate(value: unknown, name: string): Gate {
  if (value === undefined || value === null) badRequest(`${name} is required`);
  return parseGate(value, name);
}

/**
 * An optional gate field. `undefined` → leave unchanged (`undefined`); `null` →
 * clear the gate (`null`); any present value is validated by {@link parseGate}.
 */
export function optionalGate(value: unknown, name: string): Gate | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseGate(value, name);
}

/**
 * Resolve the target project for a create route: body `projectId` → `?projectId=`
 * query → (when the caller is an agent executor) the agent's own project.
 * Missing → 400 "projectId is required"; unknown → 404 "Project not found".
 * The single home for this ladder so the contract can't drift between routes.
 */
export function resolveProjectId(
  req: Request,
  body: Record<string, unknown>,
  auth?: { type: string; projectId?: string },
): string {
  const projectId =
    optionalString(body.projectId, "projectId") ??
    new URL(req.url).searchParams.get("projectId") ??
    (auth?.type === "agent" ? (auth.projectId ?? null) : null);
  if (!projectId) throw new HttpError("projectId is required", 400);
  if (!getProjectById(projectId)) throw new HttpError("Project not found", 404);
  return projectId;
}

/** Require a value drawn from a fixed set. */
export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
