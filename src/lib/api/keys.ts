/**
 * Typed React Query key factory.
 *
 * Every project-scoped list key carries the scope id in its TAIL, so the
 * scope-aware caches are siblings under a stable prefix. Switching project is
 * then a prefix invalidation (`qk.runs.all`) that catches every scoped variant
 * — no hand-listed key arrays.
 *
 * Convention:
 *   qk.<domain>.all                       -> ["<domain>"]                     (prefix: invalidates everything in the domain)
 *   qk.<domain>.list(scope)               -> ["<domain>", "list", scopeKey]   (a specific scoped list)
 *   qk.<domain>.detail(id)                -> ["<domain>", "detail", id]
 *
 * Invalidating `qk.<domain>.all` matches both lists and details for that domain.
 */

import type { Scope } from "./client";

/** Stable, serializable scope tail. Keeps key identity by value, not reference. */
function scopeKey(scope?: Scope): { projectId: string | null } {
  return { projectId: scope?.projectId ?? null };
}

export const qk = {
  projects: {
    all: ["projects"] as const,
    list: () => ["projects", "list"] as const,
  },

  agents: {
    all: ["agents"] as const,
    list: (scope?: Scope) => ["agents", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    jobs: (id: string) => ["agents", "detail", id, "jobs"] as const,
    runs: (id: string) => ["agents", "detail", id, "runs"] as const,
  },

  jobs: {
    all: ["jobs"] as const,
    list: (scope?: Scope) => ["jobs", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["jobs", "detail", id] as const,
    runs: (id: string) => ["jobs", "detail", id, "runs"] as const,
  },

  // Instance-level runner registry (execution-pool health surface).
  runners: {
    all: ["runners"] as const,
    list: () => ["runners", "list"] as const,
  },

  runs: {
    all: ["runs"] as const,
    // The dashboard bundle (scheduled/running/waiting/recent) for a scope.
    list: (scope?: Scope) => ["runs", "list", scopeKey(scope)] as const,
    // A single named filter ("waiting" | "recent" | "waiting-count").
    filter: (name: string, scope?: Scope) => ["runs", "filter", name, scopeKey(scope)] as const,
    detail: (id: string) => ["runs", "detail", id] as const,
  },

  docs: {
    all: ["docs"] as const,
    list: (scope?: Scope) => ["docs", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["docs", "detail", id] as const,
    revisions: (id: string) => ["docs", "detail", id, "revisions"] as const,
  },

  envVars: {
    all: ["env-vars"] as const,
    list: (scope?: Scope) => ["env-vars", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["env-vars", "detail", id] as const,
  },

  llmConnections: {
    all: ["llm-connections"] as const,
    list: (scope?: Scope) => ["llm-connections", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["llm-connections", "detail", id] as const,
  },

  tables: {
    all: ["tables"] as const,
    list: (scope?: Scope) => ["tables", "list", scopeKey(scope)] as const,
    detail: (id: string) => ["tables", "detail", id] as const,
    rows: (id: string, page?: number) => ["tables", "detail", id, "rows", page ?? 0] as const,
  },

  users: {
    all: ["users"] as const,
    list: () => ["users", "list"] as const,
  },

  settings: {
    all: ["settings"] as const,
    detail: () => ["settings", "detail"] as const,
    timezones: () => ["settings", "timezones"] as const,
  },

  apiKeys: {
    all: ["api-keys"] as const,
    list: () => ["api-keys", "list"] as const,
  },
} as const;

/**
 * Domain prefixes that carry scope and should be invalidated on a project
 * switch. Used by the project switcher to refetch everything scoped without
 * naming individual keys.
 */
export const SCOPED_DOMAINS = [
  qk.agents.all,
  qk.jobs.all,
  qk.runs.all,
  qk.docs.all,
  qk.envVars.all,
  qk.llmConnections.all,
  qk.tables.all,
] as const;
