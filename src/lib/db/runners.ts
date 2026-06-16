import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

/**
 * The instance-level runner registry. One row per runner — the local pool runner
 * (auto-provisioned at setup) and any remote runners an operator mints. This
 * table is org-agnostic on purpose: execution is org-agnostic, tenancy only
 * shapes what users see. It replaces the file-based agent runner config
 * (runners.json) and the per-org workflow_runners table.
 */

/** A runner is either the trusted local pool or a scoped remote process. */
export type RunnerTier = "local" | "remote";

/**
 * What a runner advertises it can execute, sent on every claim and recorded for
 * the health surface. `labels` here are what the host says it serves right now;
 * the row's `labels` column is what the token is *authorized* to serve.
 */
export type RunnerCapabilities = {
  kinds: string[]; // run kinds: "agent" | "workflow"
  clis: string[]; // for agent runs: which CLIs are installed
  labels: string[]; // placement labels this runner serves
};

/** Optional restriction on a remote token: claim only this org / agent's work. */
export type RunnerScope = { orgId?: string; agentId?: string } | null;

export type RunnerRow = {
  id: string;
  name: string;
  tier: RunnerTier;
  labels: string[];
  capabilities: RunnerCapabilities | null;
  scope: RunnerScope;
  last_polled_at: number | null;
  created_at: number;
  updated_at: number;
};

/** The columns safe to expose — never the token or its hash. */
const PUBLIC_COLUMNS = `id, name, tier, labels, capabilities, scope, last_polled_at, created_at, updated_at`;

function generateRunnerToken(): string {
  return `hbrn_${crypto.randomBytes(32).toString("hex")}`;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeLabels(labels?: string[]): string[] {
  return [...new Set((labels || []).map((l) => l.trim()).filter(Boolean))];
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Shape a raw runners row (JSON columns as text) into a typed RunnerRow. */
function hydrate(row: Record<string, unknown> | undefined): RunnerRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    tier: row.tier as RunnerTier,
    labels: parseJson<string[]>(row.labels, []),
    capabilities: parseJson<RunnerCapabilities | null>(row.capabilities, null),
    scope: parseJson<RunnerScope>(row.scope, null),
    last_polled_at: (row.last_polled_at as number | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

/**
 * Register a runner and return its plaintext token exactly once (only the hash
 * is persisted). The local runner is created with `tier: 'local'` and no scope;
 * remote runners carry their authorized labels and an optional org/agent scope.
 */
export function createRunner(opts: {
  name: string;
  tier: RunnerTier;
  labels?: string[];
  scope?: RunnerScope;
}): {
  id: string;
  name: string;
  tier: RunnerTier;
  labels: string[];
  scope: RunnerScope;
  token: string;
} {
  const db = getDb();
  const id = uuid();
  const token = generateRunnerToken();
  const labels = normalizeLabels(opts.labels);
  const scope = opts.scope ?? null;

  db.prepare(`
    INSERT INTO runners (id, name, token_hash, tier, labels, scope)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.name,
    hashToken(token),
    opts.tier,
    JSON.stringify(labels),
    scope ? JSON.stringify(scope) : null,
  );

  return { id, name: opts.name, tier: opts.tier, labels, scope, token };
}

/** Resolve a runner from its bearer token, or null when unknown. */
export function authenticateRunner(token: string): RunnerRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM runners WHERE token_hash = ?`)
    .get(hashToken(token)) as Record<string, unknown> | undefined;
  return hydrate(row);
}

export function getRunnerById(id: string): RunnerRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM runners WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return hydrate(row);
}

/** Every runner in the registry — instance-wide, ordered by name. */
export function listRunners(): RunnerRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM runners ORDER BY name`).all() as Record<
    string,
    unknown
  >[];
  return rows.map((r) => hydrate(r)!);
}

/**
 * Stamp last_polled_at (the single liveness signal) and, when the runner
 * advertised capabilities on this poll, record them for the health surface.
 */
export function touchRunnerPolled(id: string, capabilities?: RunnerCapabilities): void {
  const db = getDb();
  if (capabilities) {
    db.prepare(
      `UPDATE runners SET last_polled_at = unixepoch(), capabilities = ?, updated_at = unixepoch() WHERE id = ?`,
    ).run(JSON.stringify(capabilities), id);
  } else {
    db.prepare(`UPDATE runners SET last_polled_at = unixepoch() WHERE id = ?`).run(id);
  }
}

export function deleteRunner(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM runners WHERE id = ?`).run(id);
}
