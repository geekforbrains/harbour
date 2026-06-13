/**
 * Typed fetch wrapper for the dashboard data layer.
 *
 * Every dashboard request goes through `apiFetch`, which:
 *  - sends/receives JSON
 *  - includes credentials (the `harbour_session` cookie)
 *  - throws a typed {@link ApiError} on any non-2xx response
 *
 * Org/project scoping is a query-param concern. `scoped()` injects the active
 * scope into a path so callers never hand-build `?orgId=...&projectId=...`.
 */

export type Scope = {
  /** Active org. `null`/`undefined` = no org scope (instance-admin "All orgs" or unscoped route). */
  orgId?: string | null;
  /** Active project. `null`/`undefined` = no project filter (org-wide). */
  projectId?: string | null;
};

/** Thrown by {@link apiFetch} on a non-2xx response. Carries status + parsed body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** Best-effort human-readable message from a JSON `{ error }` body. */
  get errorMessage(): string {
    if (this.body && typeof this.body === "object" && "error" in this.body) {
      const e = (this.body as { error?: unknown }).error;
      if (typeof e === "string") return e;
    }
    return this.message;
  }
}

/**
 * React Query retry predicate. Client errors (4xx) are not transient — a 401,
 * 403, or 404 will fail identically on every retry, so retrying them with
 * backoff only converts a clean failure into a multi-second hang (e.g. a stale
 * project scope 403ing the agents list). Fail fast on 4xx; keep the default
 * three attempts for 5xx and network/parse blips, which can be transient.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 3;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch JSON from a same-origin API path. Throws {@link ApiError} on non-2xx.
 * `init.body` may be passed as a plain object (auto-stringified) or a string.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);

  let body = init?.body as BodyInit | undefined;
  const isPlainBody =
    init?.body !== undefined &&
    init.body !== null &&
    typeof init.body !== "string" &&
    !(init.body instanceof FormData) &&
    !(init.body instanceof Blob) &&
    !(init.body instanceof ArrayBuffer);

  if (isPlainBody) {
    body = JSON.stringify(init!.body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...init,
    headers,
    body,
    credentials: "include",
  });

  if (!res.ok) {
    const errBody = await parseBody(res);
    throw new ApiError(res.status, errBody);
  }

  // 204 / empty body
  if (res.status === 204) return undefined as T;
  const parsed = await parseBody(res);
  return parsed as T;
}

/**
 * Inject the active scope into a path as query params. Only defined scope ids
 * are appended, so an unscoped call (`scoped(path, {})`) returns the path
 * unchanged. Preserves any query string already present on `path`.
 *
 *   scoped("/api/runs", { orgId: "o1" })            -> "/api/runs?orgId=o1"
 *   scoped("/api/runs", { orgId: "o1", projectId: "p" }) -> "/api/runs?orgId=o1&projectId=p"
 *   scoped("/api/agents?limit=5", { projectId: "p" })    -> "/api/agents?limit=5&projectId=p"
 */
export function scoped(path: string, scope: Scope = {}): string {
  const [base, existingQuery = ""] = path.split("?");
  const params = new URLSearchParams(existingQuery);
  if (scope.orgId) params.set("orgId", scope.orgId);
  if (scope.projectId) params.set("projectId", scope.projectId);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
