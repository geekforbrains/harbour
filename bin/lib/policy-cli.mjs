// `harbour policy check` — validate every agent's permission policy up front,
// so the cutover to enforced-by-default is one command instead of a research
// project. Reads the agents table straight from the SQLite DB (read-only; no
// server required) and runs each agent through the same resolveAgentPolicy the
// runner uses, so what this command approves is exactly what the runner will
// accept. Exit 0 means every agent resolves (unrestricted counts as resolved);
// exit 1 means at least one enforced agent would be refused — usable as a
// pre-deploy gate.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dbPath, describeNativeError } from "./bootstrap.mjs";
import { getHarbourDir } from "./config.mjs";
import { normalizePermissions } from "./policy.mjs";

/**
 * Parse `harbour policy check` flags. Returns { ok: true, agent } (agent is
 * null when unfiltered) or { ok: false, error } on anything unrecognized.
 */
export function parsePolicyArgs(argv = []) {
  let agent = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: "--agent requires a slug (e.g. --agent dev-agent)" };
      }
      agent = next;
      i++;
    } else if (arg.startsWith("--agent=")) {
      agent = arg.slice("--agent=".length);
      if (!agent) return { ok: false, error: "--agent requires a slug (e.g. --agent dev-agent)" };
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, agent };
}

// Fail-closed permissions normalization comes from the runner's own module
// rather than a local copy: this command's whole promise is that it approves
// exactly what the runner accepts, so a second implementation that drifted
// would mislabel an agent's mode. Re-exported for the tests that assert it.
export { normalizePermissions };

/**
 * List agents with the fields the policy check needs. Tolerates DBs from
 * before the upgrade: a missing agents table reads as no agents, and a missing
 * permissions column reads as 'enforced' — the same fail-closed default the
 * runner applies to old claim payloads.
 */
export function listAgentRows(db) {
  const hasAgents =
    db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'agents'`)
      .get().n > 0;
  if (!hasAgents) return [];
  const hasPermissions =
    db
      .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('agents') WHERE name = 'permissions'`)
      .get().n > 0;
  const permissionsCol = hasPermissions ? "a.permissions" : "'enforced'";
  return db
    .prepare(
      `SELECT a.name, a.slug, a.cli, ${permissionsCol} AS permissions, p.slug AS project_slug
       FROM agents a JOIN projects p ON p.id = a.project_id
       ORDER BY p.slug, a.slug`,
    )
    .all();
}

// Default agent loader: open the CLI-side DB read-only (same file the
// bootstrap commands use) and read the rows. Throws a human-readable error
// when the DB is missing or the native binary won't load.
function loadAgentsFromDb() {
  const file = dbPath();
  if (!fs.existsSync(file)) {
    throw new Error(`No Harbour database at ${file} — run \`harbour setup\` first.`);
  }
  let db;
  try {
    db = new Database(file, { readonly: true });
  } catch (err) {
    throw describeNativeError(err);
  }
  try {
    return listAgentRows(db);
  } finally {
    db.close();
  }
}

/**
 * Resolve every agent's policy against its workspace
 * (<harbourDir>/workspaces/<project-slug>/<agent-slug>). Pure given its
 * inputs — rows from listAgentRows plus an injected resolveAgentPolicy — so
 * tests never touch real state.
 */
export function checkAgentPolicies(rows, { resolveAgentPolicy, harbourDir }) {
  return rows.map((row) => {
    const workingDir = path.join(harbourDir, "workspaces", row.project_slug, row.slug);
    const permissions = normalizePermissions(row.permissions);
    const resolved = resolveAgentPolicy({ cli: row.cli, workingDir, permissions });
    return {
      project: row.project_slug,
      slug: row.slug,
      name: row.name,
      cli: row.cli ?? null,
      // Failures only happen in enforced mode (unrestricted never touches the
      // filesystem), so the requested mode is the effective one either way.
      mode: resolved.ok ? resolved.mode : permissions,
      ok: resolved.ok,
      reason: resolved.ok ? null : resolved.reason,
    };
  });
}

/** One aligned line per agent: project/slug, cli, mode, then OK or the failure reason. */
export function formatPolicyLines(results) {
  const ids = results.map((r) => `${r.project}/${r.slug}`);
  const idWidth = Math.max(0, ...ids.map((id) => id.length));
  const cliWidth = Math.max(0, ...results.map((r) => (r.cli ?? "-").length));
  return results.map((r, i) => {
    const status = r.ok ? "OK" : `FAIL  ${r.reason}`;
    const cli = r.cli ?? "-";
    return `  ${ids[i].padEnd(idWidth)}  ${cli.padEnd(cliWidth)}  ${r.mode.padEnd(12)}  ${status}`;
  });
}

/** Bucket counts for the summary line: enforced-and-valid, opted out, refused. */
export function summarizePolicyResults(results) {
  const failing = results.filter((r) => !r.ok).length;
  const unrestricted = results.filter((r) => r.ok && r.mode === "unrestricted").length;
  return { ok: results.length - failing - unrestricted, unrestricted, failing };
}

export function formatPolicySummary({ ok, unrestricted, failing }) {
  return `${ok} ok, ${unrestricted} unrestricted, ${failing} failing`;
}

/** Exit-code rule: 0 when every agent resolves (unrestricted included), 1 otherwise. */
export function decidePolicyExit(results) {
  return results.some((r) => !r.ok) ? 1 : 0;
}

/**
 * `harbour policy check [--agent <slug>]` — the command body. Returns the
 * process exit code. deps ({ loadAgents, resolveAgentPolicy, harbourDir, log,
 * error }) exist for tests; production callers pass nothing.
 */
export async function runPolicyCheck(args = [], deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  const parsed = parsePolicyArgs(args);
  if (!parsed.ok) {
    error(parsed.error);
    error("Usage: harbour policy check [--agent <slug>]");
    return 1;
  }

  let rows;
  try {
    rows = deps.loadAgents ? deps.loadAgents() : loadAgentsFromDb();
  } catch (err) {
    error(err.message || String(err));
    return 1;
  }

  if (parsed.agent) {
    // Accept a bare agent slug, or project/agent when slugs repeat across projects.
    const slash = parsed.agent.indexOf("/");
    const project = slash === -1 ? null : parsed.agent.slice(0, slash);
    const slug = slash === -1 ? parsed.agent : parsed.agent.slice(slash + 1);
    rows = rows.filter((r) => r.slug === slug && (!project || r.project_slug === project));
    if (rows.length === 0) {
      error(`No agent found with slug ${JSON.stringify(parsed.agent)}.`);
      return 1;
    }
  }

  if (rows.length === 0) {
    log("No agents found — nothing to check.");
    return 0;
  }

  // Imported lazily (unless injected) so the rest of the CLI never depends on
  // the policy module loading.
  const resolveAgentPolicy =
    deps.resolveAgentPolicy ?? (await import("./policy.mjs")).resolveAgentPolicy;

  const results = checkAgentPolicies(rows, {
    resolveAgentPolicy,
    harbourDir: deps.harbourDir ?? getHarbourDir(),
  });
  for (const line of formatPolicyLines(results)) log(line);
  log("");
  log(formatPolicySummary(summarizePolicyResults(results)));
  return decidePolicyExit(results);
}
