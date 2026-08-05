// `harbour update {status,title,log}` — the reporting channel a running agent
// uses to talk back to Harbour.
//
// It exists for one reason: the run protocol used to be curl, so any policy
// that restricted an agent's shell also severed its ability to report. The only
// allow rule that reliably covered it — `Bash(curl *)` — hands over the whole
// internet, which defeats the point of restricting the agent at all. A
// dedicated command collapses that to `Bash(harbour update *)`: enough to set a
// title, post to the activity log, and reach a terminal status, and nothing
// else.
//
// The run's identity and credential come from the environment the runner
// injects (HARBOUR_URL / HARBOUR_RUN_ID / HARBOUR_API_KEY), never from
// arguments — so the per-run token stays out of command lines, shell history,
// and the run's own transcript.

/** The fields an agent may update, in the order the docs introduce them. */
export const UPDATE_FIELDS = Object.freeze(["status", "title", "log"]);

/**
 * Statuses an agent may set on its own run. `running` and `pending` are the
 * harness's to assign, and `killed` belongs to the user — an agent naming one
 * of those is confused, so fail locally with the valid set rather than let the
 * server reject it three layers down.
 */
const AGENT_STATUSES = Object.freeze(["done", "failed", "waiting", "skipped"]);

/**
 * Parse `harbour update <field> <value...>`.
 *
 * Trailing argv is joined rather than required to be a single token: an
 * unquoted `harbour update log Fetched the site` is a shape models produce, and
 * rejoining it is friendlier than failing on a quote the model forgot. Nothing
 * downstream is shell-interpreted, so joining is safe.
 */
export function parseUpdateArgs(argv = []) {
  const [field, ...rest] = argv;
  if (!field) {
    return { ok: false, error: `Usage: harbour update <${UPDATE_FIELDS.join("|")}> <value>` };
  }
  if (!UPDATE_FIELDS.includes(field)) {
    return {
      ok: false,
      error: `Unknown field ${JSON.stringify(field)} — expected one of ${UPDATE_FIELDS.join(", ")}.`,
    };
  }
  const value = rest.join(" ").trim();
  if (!value) {
    return { ok: false, error: `harbour update ${field} needs a value.` };
  }
  return { ok: true, field, value };
}

/**
 * Resolve a parsed update into the HTTP call it makes. Pure, so the endpoint
 * mapping and the environment checks are testable without a server.
 *
 * `log` POSTs to the activity endpoint because that stream is appended to, not
 * replaced — the reason the command's three fields don't share one HTTP verb.
 */
export function buildUpdateRequest(field, value, env = {}) {
  const base = (env.HARBOUR_URL || "").replace(/\/+$/, "");
  const runId = env.HARBOUR_RUN_ID;
  const token = env.HARBOUR_API_KEY;
  const missing = [
    !base && "HARBOUR_URL",
    !runId && "HARBOUR_RUN_ID",
    !token && "HARBOUR_API_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing ${missing.join(", ")}. \`harbour update\` only works inside an agent run — the runner sets these when it spawns the CLI.`,
    };
  }

  if (field === "status" && !AGENT_STATUSES.includes(value)) {
    return {
      ok: false,
      error: `Unknown status ${JSON.stringify(value)} — expected one of ${AGENT_STATUSES.join(", ")}.`,
    };
  }

  const endpoint = field === "log" ? "activity" : field;
  const body =
    field === "status"
      ? { status: value }
      : field === "title"
        ? { title: value }
        : { content: value };

  return {
    ok: true,
    method: field === "log" ? "POST" : "PUT",
    url: `${base}/api/runs/${runId}/${endpoint}`,
    body,
    token,
  };
}

/**
 * Run the command. Returns a process exit code; never throws, so a transport
 * failure reads as a normal non-zero exit to the agent's shell rather than a
 * stack trace it has to interpret.
 *
 * deps ({ env, fetch, log, error }) exist for tests; production passes nothing.
 */
export async function runUpdate(args = [], deps = {}) {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  const parsed = parseUpdateArgs(args);
  if (!parsed.ok) {
    error(parsed.error);
    return 1;
  }

  const req = buildUpdateRequest(parsed.field, parsed.value, env);
  if (!req.ok) {
    error(req.error);
    return 1;
  }

  try {
    const res = await doFetch(req.url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${req.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });
    if (!res.ok) {
      // Surface the server's own message — "illegal transition done -> waiting"
      // tells the agent what to do differently; "request failed" does not.
      const detail = (await res.text().catch(() => "")).trim();
      error(`harbour update ${parsed.field} failed (${res.status})${detail ? `: ${detail}` : ""}`);
      return 1;
    }
  } catch (err) {
    error(`harbour update ${parsed.field} failed: ${err.message || err}`);
    return 1;
  }

  log(`${parsed.field} updated.`);
  return 0;
}
