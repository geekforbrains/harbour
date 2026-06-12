import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadRunnerConfigs,
  loadSessions,
  loadWorkflowRunnerConfigs,
  saveSessions,
} from "./config.mjs";
import {
  ensureWorkingDir,
  getProvider,
  resolveRunConfig,
  runCliTool,
  sanitizeThinking,
} from "./providers.mjs";

async function apiCall(url, apiKey, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Fallback poll interval for kill requests when the CLI is silent.
// The piggyback path (POST /output response) handles the common case within
// ~750ms; this catches long silent stretches.
const KILL_POLL_INTERVAL_MS = 10_000;

// Inactivity window for the agent CLI (issue #15): if the CLI produces no
// output for this long, runCliTool SIGTERMs it. This is the ONLY runner-side
// liveness limit — it catches startup hangs and mid-run stalls. The job's
// `timeout_minutes` is a separate, server-side hard ceiling (failStaleRuns),
// not enforced here, so a productive long run is never killed at a wallclock
// cap as long as it keeps streaming. Override via HARBOUR_CLI_INACTIVITY_MS
// (used for tests and for tuning chatty/quiet models).
const CLI_INACTIVITY_TIMEOUT_MS = Number(process.env.HARBOUR_CLI_INACTIVITY_MS) || 3 * 60 * 1000;

// Strip the leading HTTP verb the /next payload prefixes each endpoint with
// ("PUT https://…" → "https://…").
function stripVerb(endpoint) {
  return (endpoint || "").replace(/^[A-Z]+ /, "");
}

/**
 * The WORK prompt's API section. Note what is intentionally ABSENT: the old
 * "You MUST set a final run status … or it will be marked as failed" mandate.
 * That advice fell out of context on long runs, so runs finished statusless and
 * got force-failed. Status is now guaranteed by execution — the harness drives a
 * dedicated finalize turn (buildFinalizePrompt) after the work turn. We still
 * document the status endpoint here because setting `waiting` mid-run (to hand
 * off to a human) is a legitimate action the agent takes during the work itself.
 */
export function buildApiPrompt(api, apiKey) {
  const setTitleUrl = stripVerb(api.endpoints.set_title);
  const runStatusUrl = stripVerb(api.endpoints.update_status);
  const activityUrl = stripVerb(api.endpoints.post_activity);
  const uploadUrl = stripVerb(api.endpoints.upload_attachment);
  const guideUrl = stripVerb(api.endpoints.guide);

  return `## Harbour API

Your output will be posted as a comment on this run. Write a clear, concise summary.

Before doing anything else, set a short title for this run (max 80 chars) so humans can identify it on the dashboard:
  curl -X PUT ${setTitleUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"title":"your short title"}'

Use these curl commands with the provided API key:

If you need human input to continue, set status to waiting (explain what you need in an activity message first):
  curl -X PUT ${runStatusUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"status":"waiting"}'

Post an activity message (visible on dashboard):
  curl -X POST ${activityUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"content":"your message"}'

Upload an attachment (file) to this run:
  curl -X POST ${uploadUrl} -H "Authorization: Bearer ${apiKey}" -F "file=@/path/to/file.png"

Download an attachment file (use the url shown in the Attachments section):
  curl -H "Authorization: Bearer ${apiKey}" -o /tmp/file.png "<attachment url>"

Full API spec (docs, databases, etc): ${guideUrl}
`;
}

/** The valid finish set — a run cannot leave the runner without one of these. */
export const TERMINAL_STATUSES = Object.freeze(["done", "waiting", "failed", "skipped"]);

/** Cap on finalize attempts before we force `failed` as a backstop. */
export const FINALIZE_MAX_ATTEMPTS = 3;

/** True when `status` is a valid terminal/finish value. */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** Whether the finalize turn should run (i.e. the agent left no terminal status). */
export function shouldRunFinalize(status) {
  return !isTerminalStatus(status);
}

/**
 * Decide how the finalize turn invokes the CLI:
 *   - "resume" — resume the SAME session so the agent has full context of the
 *     work it just did. Requires the provider to support resume AND a session id.
 *   - "fresh"  — no resumable session (provider can't resume, or session id was
 *     lost); send a fresh turn whose prompt carries the activity log as context.
 * Resume is always same-provider (resume is provider-bound), so we never need to
 * pick a different CLI.
 *
 * @param {{ canResume?: boolean }} provider
 * @param {string|null} sessionId
 * @returns {{ mode: 'resume'|'fresh' }}
 */
export function resolveFinalizeMode(provider, sessionId) {
  if (provider?.canResume && sessionId) return { mode: "resume" };
  return { mode: "fresh" };
}

/**
 * The FINALIZE prompt: a tight, single-purpose turn whose only job is to set a
 * valid terminal status. This is where the old work-prompt mandate now lives —
 * but enforced by the harness re-checking status after the turn, not by the
 * model remembering.
 *
 * @param {object} api
 * @param {string} apiKey
 * @param {object} opts
 * @param {'resume'|'fresh'} opts.mode
 * @param {string} [opts.activityContext] - the run's activity log, inlined ONLY
 *   in fresh mode (a resumed session already has it).
 */
export function buildFinalizePrompt(api, apiKey, { mode = "resume", activityContext = "" } = {}) {
  const runStatusUrl = stripVerb(api.endpoints.update_status);
  const set = TERMINAL_STATUSES.join(", ");

  let context = "";
  if (mode === "fresh" && activityContext) {
    context = `Here is the activity log of the work that was just done:\n\n${activityContext}\n\n`;
  }

  return `${context}You MUST set a final run status now. Review what you just did and set the run status to exactly one of {${set}} via the status endpoint:
  curl -X PUT ${runStatusUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"status":"<status>"}'

Choose:
  - done    — the task completed successfully
  - waiting — you need human input to continue (explain what you need in an activity message first)
  - failed  — something went wrong and the task could not be completed
  - skipped — there was no work to do

Do nothing else. Set the status and stop.
`;
}

/**
 * One step of the finalize loop, given the status re-checked AFTER a finalize
 * turn and the attempt number (1-based). Pure so the loop's stop/continue/force
 * logic is unit-testable apart from the CLI plumbing.
 *
 *   - terminal status reached → stop with that outcome (waiting is valid)
 *   - non-terminal, attempts remain → continue
 *   - non-terminal on the last attempt → force `failed` (backstop)
 *
 * @param {{ status: string, attempt: number }} args
 * @returns {{ done: boolean, outcome?: string, forced: boolean }}
 */
export function finalizeStep({ status, attempt }) {
  if (isTerminalStatus(status)) return { done: true, outcome: status, forced: false };
  if (attempt >= FINALIZE_MAX_ATTEMPTS) return { done: true, outcome: "failed", forced: true };
  return { done: false, forced: false };
}

/**
 * Resolve the outcome when a kill lands during a CLI turn. A kill is MOOT when
 * the run already reached a terminal status before SIGTERM took effect — the
 * agent finished (or parked on `waiting`) first, so we respect that status
 * rather than forcing `killed`. Forcing `killed` on top would be wrong and, for
 * a terminal value, an illegal transition (e.g. done → killed is rejected by the
 * status guard). Any non-terminal status (running/pending/none) is a real kill.
 *
 * Shared by both the work turn and the finalize turn so the rule lives once.
 *
 * @param {string|null|undefined} statusAtKill - status read back after the kill
 * @returns {string} the terminal outcome to report
 */
export function resolveKillOutcome(statusAtKill) {
  return isTerminalStatus(statusAtKill) ? statusAtKill : "killed";
}

function formatBytes(n) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Render a list of attachments (files + embeds) as a markdown-ish block.
 * Used both standalone (full list at the top of the prompt) and inline
 * under activity entries the attachment was linked to.
 */
function renderAttachmentList(atts, indent = "") {
  const lines = [];
  for (const a of atts) {
    if (a.kind === "file") {
      const size = formatBytes(a.size_bytes);
      const meta = [a.mime_type, size].filter(Boolean).join(", ");
      const who = a.uploaded_by_name ? ` — uploaded by ${a.uploaded_by_name}` : "";
      lines.push(`${indent}- [file] ${a.filename}${meta ? ` (${meta})` : ""}${who}`);
      if (a.url) lines.push(`${indent}  ${a.url}`);
    } else if (a.kind === "embed") {
      const provider = a.embed_provider || "link";
      const title = a.title || a.url || "(untitled)";
      const who = a.uploaded_by_name ? ` — shared by ${a.uploaded_by_name}` : "";
      lines.push(`${indent}- [${provider}] ${title}${who}`);
      if (a.url && a.url !== title) lines.push(`${indent}  ${a.url}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(payload, apiKey, isResume) {
  const apiPrompt = payload.api ? buildApiPrompt(payload.api, apiKey) : "";
  const allAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  // Group attachments by the activity entry they were linked to, so we can
  // render them inline under the message they arrived with.
  const attsByActivity = new Map();
  const orphanAtts = [];
  for (const a of allAttachments) {
    if (a.activity_id) {
      if (!attsByActivity.has(a.activity_id)) attsByActivity.set(a.activity_id, []);
      attsByActivity.get(a.activity_id).push(a);
    } else {
      orphanAtts.push(a);
    }
  }

  function renderActivityBlock(entries) {
    const out = [];
    for (const a of entries) {
      if (a.content) out.push(`[${a.author_type}] ${a.content}`);
      const linked = attsByActivity.get(a.id);
      if (linked?.length) {
        out.push(
          `[${a.author_type}] attached ${linked.length} ${linked.length === 1 ? "attachment" : "attachments"}:`,
        );
        out.push(renderAttachmentList(linked, "  "));
      }
      out.push("");
    }
    return out.join("\n").trim();
  }

  if (isResume) {
    const activity = payload.run.activity || [];
    const lastAgentIdx = activity.findLastIndex((a) => a.author_type === "agent");
    const newEntries = lastAgentIdx >= 0 ? activity.slice(lastAgentIdx + 1) : activity;
    const humanEntries = newEntries.filter(
      (a) => a.author_type === "user" || a.author_type === "system",
    );

    let resumePrompt = `The human has responded to your previous work. Here is their message:\n\n${renderActivityBlock(humanEntries)}\n\n`;

    // Also list any attachments on the run that aren't tied to a specific
    // activity entry (shouldn't happen in practice, but keeps the agent from
    // missing anything).
    if (orphanAtts.length > 0) {
      resumePrompt += `## Other Attachments\n\n${renderAttachmentList(orphanAtts)}\n\n`;
    }

    resumePrompt += `Continue working on this task based on their response. If they attached files or embeds above, fetch them with curl using the API key (see "Download an attachment file" below) before responding.\n\n${apiPrompt}`;
    return resumePrompt;
  }

  let prompt = "";

  if (payload.job?.name) {
    prompt += `# Job: ${payload.job.name}\n\n`;
  }
  if (payload.job?.instructions) {
    prompt += `## Instructions\n\n${payload.job.instructions}\n\n`;
  }

  if (payload.docs?.length > 0) {
    prompt += `## Reference Documents\n\n`;
    for (const doc of payload.docs) {
      prompt += `### ${doc.title}\n\n${doc.content || "(empty)"}\n\n`;
    }
  }

  if (payload.data && Object.keys(payload.data).length > 0) {
    prompt += `## Reference Data\n\n`;
    prompt += `To add or read rows, use the insert_rows / read_rows endpoints from the api section with each table's database id below.\n\n`;
    for (const [name, info] of Object.entries(payload.data)) {
      // Current shape: { id, columns, rows }. Tolerate the old rows[] shape too.
      const rows = Array.isArray(info) ? info : info?.rows || [];
      const id = Array.isArray(info) ? null : info?.id;
      const columns = Array.isArray(info) ? null : info?.columns;
      prompt += `### ${name}\n`;
      if (id) prompt += `database id: ${id}\n`;
      if (columns?.length)
        prompt += `columns: ${columns.map((c) => `${c.name} (${c.type})`).join(", ")}\n`;
      prompt += `\n`;
      if (rows.length > 0) {
        prompt += `\`\`\`json\n${JSON.stringify(rows.slice(0, 20), null, 2)}\n\`\`\`\n\n`;
      } else {
        prompt += `(no rows)\n\n`;
      }
    }
  }

  const activity = payload.run.activity || [];
  if (activity.length > 0) {
    prompt += `## Activity Log\n\n${renderActivityBlock(activity)}\n\n`;
  }

  // Standalone (not linked to any activity entry) — show as a plain list.
  if (orphanAtts.length > 0) {
    prompt += `## Attachments\n\nFiles and embeds attached to this run. Fetch files by curl'ing the URL with your Bearer token (see "Download an attachment file" below).\n\n${renderAttachmentList(orphanAtts)}\n\n`;
  }

  if (payload.env && Object.keys(payload.env).length > 0) {
    prompt += `## Environment Variables\n\nThese credentials and secrets are available for this run. Use them when making API calls or authenticating with services.\n\n`;
    for (const [key, value] of Object.entries(payload.env)) {
      prompt += `- \`${key}\`: \`${value}\`\n`;
    }
    prompt += "\n";
  }

  // Prerun output is appended by the runner after executing the prerun command.

  prompt += apiPrompt;

  return prompt;
}

/**
 * Run a workflow command. Pipes the full payload JSON to stdin.
 * Exit 0 = success, exit 77 = skip (no work), any other non-zero = error.
 * Returns { code, stdout, stderr }.
 *
 * @param {object} opts
 * @param {number} [opts.timeoutMs] - timeout in milliseconds (30s for gate, job timeout for workflow)
 * @param {AbortSignal} [opts.signal] - abort signal for kill handling
 * @param {number} [opts.killGraceMs] - ms to wait after SIGTERM before SIGKILL on abort
 * @param {Record<string,string>} [opts.extraEnv] - env vars layered onto the
 *   child's environment (job-linked secrets + HARBOUR_* run credentials), so a
 *   script can expand `$VAR` and post live progress updates to its run.
 */
export function runWorkflow(command, payloadJson, cwd, opts = {}) {
  const { timeoutMs = 30_000, signal, extraEnv, killGraceMs = 3000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let closeFired = false;
    let postExitTimer = null;
    let sigkillTimer = null;
    // Workflows can background processes (dev servers, docker) that inherit
    // our stdout/stderr. Guard against "close" never firing by destroying
    // the pipes shortly after the workflow process itself exits.
    const POST_EXIT_GRACE_MS = 2000;

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (postExitTimer) clearTimeout(postExitTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });
    child.on("exit", () => {
      postExitTimer = setTimeout(() => {
        if (closeFired) return;
        try {
          child.stdout?.destroy();
        } catch {}
        try {
          child.stderr?.destroy();
        } catch {}
      }, POST_EXIT_GRACE_MS);
    });
    child.on("close", (code) => {
      closeFired = true;
      if (postExitTimer) clearTimeout(postExitTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({ code, stdout, stderr });
    });

    // Kill on abort: SIGTERM, then SIGKILL after a grace period in case the
    // child traps/ignores SIGTERM (mirrors runCliTool). Without escalation a
    // workflow that swallows SIGTERM would hang until the job timeout, leaving
    // the run stuck `running` with the dashboard Kill button frozen.
    if (signal) {
      const terminate = () => {
        try {
          child.kill("SIGTERM");
        } catch {}
        sigkillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, killGraceMs);
      };
      if (signal.aborted) terminate();
      else signal.addEventListener("abort", terminate, { once: true });
    }

    // Pipe the payload to stdin. A script that never reads stdin (or exits
    // before we finish writing) closes the pipe early; swallow the resulting
    // EPIPE rather than letting it surface as an unhandled stream error.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(payloadJson);
      child.stdin.end();
    } catch {
      /* pipe already closed */
    }
  });
}

/**
 * Run a job gate command (prerun OR postrun) with the shared scaffolding both
 * need: ensure ~/.harbour/workflows exists, pipe the payload JSON on stdin, and
 * poll for a mid-gate kill request that aborts the child (SIGTERM→grace→SIGKILL
 * inside runWorkflow). Returns { code, stdout, stderr, killed }.
 *
 * Extracted so prerun and postrun share one implementation rather than two
 * copies of the kill-poll/timeout dance.
 *
 * @param {object} args
 * @param {string} args.command       - the shell command to run
 * @param {string} args.payloadJson   - run payload + activity, piped to stdin
 * @param {string} args.url           - harbour base url (for kill polling)
 * @param {string} args.apiKey
 * @param {string} args.runId
 * @param {string} args.agentName     - for log lines
 * @param {string} args.label         - "Prerun" | "Postrun" (log prefix)
 * @param {number} [args.timeoutMs]   - gate timeout (default 30s)
 * @param {number} [args.killPollIntervalMs]
 * @param {Record<string,string>} [args.extraEnv]
 */
async function runGateCommand({
  command,
  payloadJson,
  url,
  apiKey,
  runId,
  agentName,
  label,
  timeoutMs = 30_000,
  killPollIntervalMs = KILL_POLL_INTERVAL_MS,
  extraEnv,
}) {
  const dir = join(process.env.HARBOUR_HOME || join(homedir(), ".harbour"), "workflows");
  mkdirSync(dir, { recursive: true });

  const killController = new AbortController();
  let killed = false;
  const killPoll = setInterval(async () => {
    if (killed) return;
    try {
      const res = await apiCall(`${url}/api/runs/${runId}/kill`, apiKey);
      if (res?.kill_requested) {
        killed = true;
        killController.abort();
        console.log(`  [${agentName}] Kill requested during ${label.toLowerCase()} — stopping`);
      }
    } catch {
      /* best effort */
    }
  }, killPollIntervalMs);

  try {
    const wfResult = await runWorkflow(command, payloadJson, dir, {
      timeoutMs,
      signal: killController.signal,
      extraEnv,
    });
    return { ...wfResult, killed };
  } finally {
    clearInterval(killPoll);
  }
}

// Cap on consecutive eager iterations within a single launchd tick.
// Guards against a bug in getAgentNextRun ever returning non-null in a loop.
// 50 is plenty for any realistic backlog; launchd respawns us next minute anyway.
export const EAGER_MAX_ITERATIONS = 50;

/**
 * Decide whether the eager loop should continue after one run finishes.
 * Pure function — exposed for unit testing. Encodes:
 *   - "no-work" / "poll-error": always exit (nothing to do or transient issue)
 *   - eager off: never loop (single shot per tick)
 *   - failed / killed: exit (let the 60s gap absorb transient errors;
 *                            kill = user said stop)
 *   - done / waiting / skipped: continue draining
 *
 * @param {string} outcome - one of: no-work, poll-error, done, waiting, skipped, failed, killed, running
 * @param {boolean} eager - the agent's eager flag (live from /next payload)
 * @returns {boolean}
 */
export function shouldContinueEagerLoop(outcome, eager) {
  if (outcome === "no-work" || outcome === "poll-error") return false;
  if (!eager) return false;
  return outcome === "done" || outcome === "waiting" || outcome === "skipped";
}

// ---- Postrun gate (#29) ----------------------------------------------------
// A deterministic post-agent hook, the symmetric twin of the prerun gate. It
// runs AFTER the run reaches a terminal status (after #34's finalize), with the
// run payload + activity on stdin, in ~/.harbour/workflows — same shape prerun
// receives. Two modes, set by the job's postrun_gates flag:
//
//   OFF — informational (default): cleanup / notification / chaining. Runs on
//     ANY terminal outcome where the agent turn executed; its output is captured
//     as a workflow activity entry; it NEVER changes the run's status.
//   ON  — enforcing: proof-of-work verification. Runs after `done` only; a
//     nonzero exit overrides `done -> failed` (the edge #30 reserves for us),
//     surfacing the gate's stderr as the failure reason.
//
// WHY only outcomes where the agent turn executed (and never a pure prerun-skip):
// the gate is a hook on the *agent's work*. A prerun skip (exit 77) means there
// was no work to do, so the agent turn never ran — there is nothing to clean up,
// verify, or chain from. Firing postrun there would run cleanup against a run
// that did nothing, and (in enforcing mode) could never apply anyway since the
// run is `skipped`, not `done`. The prerun-skip/fail paths return before the
// single-exit seam, so they never reach the postrun branch; we additionally pass
// an explicit `agentRan` flag so the decision is testable and intentional.

/** Terminal outcomes the informational (non-gating) postrun may fire on. */
const POSTRUN_INFORMATIONAL_OUTCOMES = Object.freeze(["done", "failed", "killed", "skipped"]);

/**
 * Whether to invoke the postrun command at all. Pure so the runner's seam logic
 * is unit-testable apart from the CLI/shell plumbing.
 *
 * @param {object} args
 * @param {string|null|undefined} args.command - the job's postrun_command
 * @param {string} args.outcome - the run's finalized terminal status
 * @param {boolean} args.gates - postrun_gates flag (true = enforcing)
 * @param {boolean} args.agentRan - did the agent work turn actually execute?
 * @returns {boolean}
 */
export function shouldRunPostrun({ command, outcome, gates, agentRan }) {
  if (!command) return false; // null/absent/empty → no-op, zero tax
  if (!agentRan) return false; // pure prerun-skip etc. → never fires
  if (gates) return outcome === "done"; // enforcing: done only
  return POSTRUN_INFORMATIONAL_OUTCOMES.includes(outcome); // informational: any terminal
}

/**
 * Given the postrun command's exit code, decide whether the gate overrides the
 * run's status. Pure. Informational mode never overrides; enforcing mode turns a
 * `done` into `failed` on any nonzero exit (and only that edge — the transition
 * guard in updateRunStatus permits exactly done -> failed for the gate).
 *
 * @param {object} args
 * @param {boolean} args.gates - postrun_gates flag (true = enforcing)
 * @param {number} args.code - the postrun command's exit code
 * @param {string} args.outcome - the run's finalized terminal status
 * @returns {{ status: string|null }} status to set, or null to leave unchanged
 */
export function postrunStatusOverride({ gates, code, outcome }) {
  if (!gates) return { status: null }; // informational: never changes status
  if (outcome === "done" && code !== 0) return { status: "failed" };
  return { status: null };
}

/**
 * Decide what status a kill landing DURING postrun should set. Postrun only ever
 * runs AFTER the run reaches a terminal status (done/failed/skipped/killed), so a
 * kill at this point can't re-finalize an already-finished run: done -> killed,
 * failed -> killed and skipped -> killed are all illegal under
 * LEGAL_RUN_TRANSITIONS (and killed -> killed is a no-op). The run is finished;
 * only postrun cleanup was still executing. So we NEVER issue a status PUT here —
 * we honor the existing terminal outcome. Pure, mirrors postrunStatusOverride.
 *
 * @param {object} _args
 * @param {string} _args.outcome - the run's already-finalized terminal status
 * @returns {{ status: string|null }} status to set, or null to leave unchanged
 */
export function postrunKillStatus(_args) {
  return { status: null };
}

/**
 * Run ONE CLI turn end-to-end: invoke the CLI, stream its output to Harbour,
 * handle a mid-turn kill request, and parse the final result. Both the work
 * turn and the finalize turn (issue #34) go through this — the kill/stream
 * plumbing exists in exactly one place.
 *
 * Returns { result, sessionId, output, killed, statusAtKill }:
 *   - result      — the raw { code, stdout, stderr, aborted } from runCliTool
 *   - sessionId   — the session id captured during the turn (may be newer than
 *                   the one passed in, e.g. a provider that mints it at init)
 *   - output      — parsed final content (provider.parseResult)
 *   - killed      — true if a kill request fired during the turn
 *   - statusAtKill— the run's status read back after a kill (only when killed)
 *
 * Throws if runCliTool itself throws (spawn/exec failure) — the caller maps
 * that to a hard failure.
 */
async function runCliTurn({
  cmd,
  provider,
  url,
  apiKey,
  runId,
  agentName,
  sessionId,
  extraEnv,
  sessionAlreadyReported,
}) {
  // Batch streaming events and flush to Harbour periodically
  let eventBatch = [];
  let flushTimer = null;
  const FLUSH_INTERVAL = 750; // ms

  // Kill plumbing: the Next.js server sets runs.kill_requested_at when the
  // user clicks Kill in the dashboard. We learn about it two ways:
  //   1. Piggyback — POST /output returns { kill_requested: true } (hot path,
  //      latency ≤ 750ms while the CLI is streaming)
  //   2. Fallback — GET /runs/:id/kill on a 10s interval (catches silent CLIs)
  // Either path fires the AbortController, which triggers the SIGTERM+grace+
  // SIGKILL sequence inside runCliTool.
  const killController = new AbortController();
  let killed = false;
  function triggerKill(reason) {
    if (killed) return;
    killed = true;
    console.log(`  [${agentName}] Kill requested (${reason}) — stopping run ${runId}`);
    killController.abort();
  }

  async function flushEvents() {
    if (eventBatch.length === 0) return;
    const batch = eventBatch;
    eventBatch = [];
    try {
      const res = await apiCall(`${url}/api/runs/${runId}/output`, apiKey, "POST", batch);
      if (res?.kill_requested) triggerKill("piggyback");
    } catch (err) {
      console.error(`  [${agentName}] Failed to stream output: ${err.message}`);
    }
  }

  // Fallback kill poll — catches the case where the CLI goes silent for a
  // long thinking stretch and we have nothing to piggyback on.
  const killPollTimer = setInterval(async () => {
    if (killed) return;
    try {
      const res = await apiCall(`${url}/api/runs/${runId}/kill`, apiKey);
      if (res?.kill_requested) triggerKill("poll");
    } catch {
      /* best effort — server may be restarting */
    }
  }, KILL_POLL_INTERVAL_MS);

  function queueEvent(evt) {
    eventBatch.push(evt);
    if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        await flushEvents();
      }, FLUSH_INTERVAL);
    }
  }

  // Create a stateful parser if the provider supports it (e.g. Claude
  // accumulates tool input deltas), otherwise fall back to stateless parseLine.
  const parser = provider.createParser ? provider.createParser() : provider;

  // Line handler: parse each JSONL line from the CLI tool
  let turnSessionId = sessionId;
  let sessionReported = !!sessionAlreadyReported;
  function onLine(line) {
    if (!parser.parseLine) return;
    const parsed = parser.parseLine(line);
    if (!parsed) return;

    // Capture session ID from init events
    if (parsed.sessionId) {
      turnSessionId = parsed.sessionId;
    }

    // Report session ID to the server (once) so it's available on the dashboard
    if (turnSessionId && !sessionReported) {
      sessionReported = true;
      apiCall(`${url}/api/runs/${runId}/session`, apiKey, "PUT", {
        session_id: turnSessionId,
        cwd: cmd.cwd,
      }).catch((err) =>
        console.error(`  [${agentName}] Failed to report session ID: ${err.message}`),
      );
    }

    for (const evt of parsed.events) {
      queueEvent(evt);
    }
  }

  let result;
  try {
    result = await runCliTool(cmd.binary, cmd.args, cmd.cwd, {
      inactivityTimeoutMs: CLI_INACTIVITY_TIMEOUT_MS,
      onLine,
      signal: killController.signal,
      extraEnv: extraEnv || {},
    });
  } finally {
    clearInterval(killPollTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  // Flush any remaining buffered events after the CLI exits.
  await flushEvents();

  const parsed = provider.parseResult(result.stdout, turnSessionId);
  const output = parsed.content || result.stdout || result.stderr || "(no output)";
  const finalSessionId = parsed.sessionId || turnSessionId;

  // On a kill, re-read the server's status: the agent may have finished
  // naturally in the tiny window between the kill request and SIGTERM landing.
  let statusAtKill = null;
  if (killed) {
    statusAtKill = "running";
    try {
      const run = await apiCall(`${url}/api/runs/${runId}/status`, apiKey);
      statusAtKill = run.status;
    } catch {
      /* best effort */
    }
  }

  return { result, sessionId: finalSessionId, output, killed, statusAtKill };
}

/**
 * Process at most one run for this runner.
 * Returns { outcome, eager } where outcome is:
 *   'no-work'    — poll returned null (no queued/scheduled/due work)
 *   'poll-error' — fetch threw (network/server error)
 *   'done'       — run finished normally
 *   'waiting'    — run paused for human input
 *   'skipped'    — prerun/workflow command exited 77, or run skipped
 *   'failed'     — CLI/workflow error, agent didn't set status, etc.
 *   'killed'     — user requested kill mid-run
 * `eager` reflects the live `agent.eager` flag from the /next payload (or the
 * cached runner config if the payload didn't include one).
 */
async function processNextRun(runner) {
  const { agentId, apiKey, name: agentName, url } = runner;
  const sessions = loadSessions();

  console.log(`  [${agentName}] Polling...`);

  // Poll for next run
  let payload;
  try {
    payload = await apiCall(`${url}/api/agents/${agentId}/next`, apiKey);
  } catch (err) {
    console.error(`  [${agentName}] Poll failed: ${err.message}`);
    return { outcome: "poll-error", eager: false };
  }

  if (!payload?.run) {
    console.log(`  [${agentName}] Nothing to do.`);
    return { outcome: "no-work", eager: false };
  }

  // cli/model/thinking come live from the /next payload (harbour is the source
  // of truth); the runner config is identity-only but may carry legacy values
  // as a fallback. Resolve before anything that needs the provider.
  const { cli, model: agentModel, thinking: resolvedThinking } = resolveRunConfig(payload, runner);
  if (!cli) {
    console.error(`  [${agentName}] No CLI configured for this agent — set one in the dashboard.`);
    return { outcome: "config-error", eager: false };
  }
  const provider = getProvider(cli);

  // A thinking level the CLI won't accept must not fail the run (issue #39:
  // `--effort off` killed every launch) — drop it and run on the CLI default.
  const { thinking: agentThinking, dropped: droppedThinking } = sanitizeThinking(
    cli,
    resolvedThinking,
  );

  // Live eager flag from server, falling back to cached runner config
  const eager = payload.agent?.eager !== undefined ? !!payload.agent.eager : !!runner.eager;

  const runId = payload.run.id;

  if (droppedThinking) {
    const warning = `Ignoring unsupported thinking level \`${droppedThinking}\` for ${cli} — running with the CLI default. Fix the agent or job's thinking setting in the dashboard.`;
    console.error(`  [${agentName}] ${warning}`);
    apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: warning }).catch(() => {
      /* best effort */
    });
  }

  const existingSession = sessions[runId];
  const isResume = !!existingSession;
  let sessionId = existingSession?.sessionId || null;
  const isNewSession = !isResume;

  // ---- Workspace resolution (issue #40) -------------------------------------
  // Workspaces mirror the data-model hierarchy on disk —
  // ~/.harbour/workspaces/<org-slug>/<project-slug>/<agent-slug>/ — built from
  // the payload's `workspace` block of server-assigned, immutable slugs.
  // Resolution ladder:
  //   1. A resumed session's pinned cwd, verbatim. Claude CLI sessions are
  //      cwd-scoped, so a moved cwd breaks --resume — the path saved at run
  //      start wins over any rename or layout change made since.
  //   2. A resumed session WITHOUT a cwd was persisted by a pre-upgrade
  //      runner, which necessarily started under the legacy flat layout —
  //      resume there so the session and working tree are found.
  //   3. payload.workspace → the nested layout.
  //   4. No workspace block (older server) → legacy flat layout.
  // The legacy slug keeps the OLD inline derivation byte-for-byte so existing
  // installs keep their directories.
  const legacySlug = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const ws = payload.workspace;
  let workingDir;
  try {
    if (existingSession?.cwd) {
      workingDir = existingSession.cwd;
      mkdirSync(workingDir, { recursive: true });
    } else if (existingSession) {
      workingDir = ensureWorkingDir([legacySlug]);
    } else if (
      ws &&
      typeof ws.org === "string" &&
      typeof ws.project === "string" &&
      typeof ws.agent === "string"
    ) {
      workingDir = ensureWorkingDir([ws.org, ws.project, ws.agent]);
    } else {
      console.warn(
        `  [${agentName}] Server sent no workspace block (predates workspace scoping) — using the legacy flat workspace layout.`,
      );
      workingDir = ensureWorkingDir([legacySlug]);
    }
  } catch (err) {
    const message = `Cannot resolve workspace directory: ${err.message}. Refusing to run — fix the slugs server-side.`;
    console.error(`  [${agentName}] ${message}`);
    apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: message }).catch(() => {
      /* best effort */
    });
    return { outcome: "config-error", eager: false };
  }

  // For Claude, generate a session ID upfront so we can always resume
  if (isNewSession && provider.generateSessionId) {
    sessionId = provider.generateSessionId();
    // Report pre-generated session ID immediately
    apiCall(`${url}/api/runs/${runId}/session`, apiKey, "PUT", {
      session_id: sessionId,
      cwd: workingDir,
    }).catch((err) =>
      console.error(`  [${agentName}] Failed to report session ID: ${err.message}`),
    );
  }

  console.log(
    `  [${agentName}] ${isResume ? "Resuming" : "Starting"} run ${runId} (${payload.job?.name || "one-off"})`,
  );

  // Execute agent prerun command (if defined). This is a cheap gate to avoid
  // spending LLM tokens when there is no work.
  let prerunOutput = "";
  if (!isResume && payload.job?.prerun) {
    try {
      const wfResult = await runGateCommand({
        command: payload.job.prerun,
        payloadJson: JSON.stringify(payload),
        url,
        apiKey,
        runId,
        agentName,
        label: "Prerun",
      });

      if (wfResult.killed) {
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
        } catch {
          /* best effort */
        }
        return { outcome: "killed", eager };
      }

      if (wfResult.code === 77) {
        // Skip — no work to do
        console.log(`  [${agentName}] Prerun exited 77 — skipping`);
        if (wfResult.stderr?.trim()) {
          try {
            await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
              content: wfResult.stderr.trim(),
            });
          } catch {
            /* best effort */
          }
        }
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "skipped" });
        } catch {
          /* best effort */
        }
        return { outcome: "skipped", eager };
      }

      if (wfResult.code !== 0) {
        // Error — any non-zero except 77
        console.error(`  [${agentName}] Prerun exited ${wfResult.code} — failed`);
        const errOutput =
          wfResult.stderr?.trim() ||
          wfResult.stdout?.trim() ||
          `Prerun exited with code ${wfResult.code}`;
        // Two independent best-effort calls (issue #15): a failed activity POST
        // must not skip the status PUT, or the run dangles in 'running'.
        try {
          await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
            content: errOutput,
          });
        } catch {
          /* best effort */
        }
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
        } catch {
          /* best effort */
        }
        return { outcome: "failed", eager };
      }

      // Exit 0 — success, capture output for prompt context
      prerunOutput = wfResult.stdout?.trim() || "";
    } catch (err) {
      console.error(`  [${agentName}] Prerun command failed: ${err.message}`);
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
          content: `Prerun error: ${err.message}`,
        });
      } catch {
        /* best effort */
      }
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch {
        /* best effort */
      }
      return { outcome: "failed", eager };
    }
  }

  // Build the work prompt — append prerun output as additional context.
  let prompt = buildPrompt(payload, apiKey, isResume);
  if (prerunOutput) {
    prompt += `## Prerun Output\n\n${prerunOutput}\n\n`;
  }

  // model/thinking were already resolved (job override > agent default) above.
  const cmd = provider.buildCommand(
    prompt,
    agentModel,
    workingDir,
    sessionId,
    isNewSession,
    agentThinking,
  );

  // ---- Single exit path -----------------------------------------------------
  // Every terminal return below funnels through finish(): it does the session
  // save/cleanup, fires the postrun gate (#29) AFTER status finalization, and
  // returns { outcome, eager }. The postrun gate may override the outcome
  // (enforcing mode: done -> failed), so finish() returns the resolved outcome.
  //
  //   opts.agentRan         — did the agent work turn actually execute? Postrun
  //                           only fires when it did (a pure prerun-skip never
  //                           reaches finish, so this is true at every callsite
  //                           except a CLI-spawn failure where the turn never ran).
  //   opts.preserveSession  — keep the saved session for resume even though the
  //                           outcome isn't `waiting` (the kill path).
  async function finish(
    outcome,
    finalSessionId,
    { agentRan = true, preserveSession = false } = {},
  ) {
    if (finalSessionId && (outcome === "waiting" || preserveSession)) {
      // cwd pins the workspace for resumes: the CLI session lives under this
      // directory, so later turns must run there even if the agent is renamed
      // or the layout changes in the meantime.
      sessions[runId] = { sessionId: finalSessionId, cli, cwd: workingDir };
      saveSessions(sessions);
    } else {
      delete sessions[runId];
      saveSessions(sessions);
    }

    // ---- Postrun gate (#29) — runs AFTER status finalization ----------------
    const resolved = await runPostrun({
      job: payload.job,
      outcome,
      agentRan,
      url,
      apiKey,
      runId,
      agentName,
      env: payload.env || {},
      payloadJson: JSON.stringify(payload),
    });

    console.log(`  [${agentName}] Run ${runId} completed with status: ${resolved}`);
    return { outcome: resolved, eager };
  }

  // ---- Work turn ------------------------------------------------------------
  let turn;
  try {
    turn = await runCliTurn({
      cmd,
      provider,
      url,
      apiKey,
      runId,
      agentName,
      sessionId,
      extraEnv: payload.env || {},
      sessionAlreadyReported: !!sessionId,
    });
  } catch (err) {
    console.error(`  [${agentName}] CLI execution failed: ${err.message}`);
    // Independent best-effort calls (issue #15): the status PUT must fire even
    // if the activity POST throws, else the run is stuck 'running'.
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Runner error: CLI tool "${cli}" failed to execute: ${err.message}`,
      });
    } catch {
      /* best effort */
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch {
      /* best effort */
    }
    // The CLI never spawned — the agent turn did not execute, so postrun (which
    // hooks the agent's work) does not fire here.
    return finish("failed", turn?.sessionId || sessionId, { agentRan: false });
  }

  const { result, output } = turn;
  const workSessionId = turn.sessionId;

  // ---- Kill ----------------------------------------------------------------
  // User-initiated kill: save session, post activity, set status=killed, and
  // bail BEFORE the finalize turn (which would otherwise resume the killed run).
  if (turn.killed) {
    const killOutcome = resolveKillOutcome(turn.statusAtKill);
    if (killOutcome !== "killed") {
      // Race: agent finished naturally before SIGTERM landed — respect the
      // status it set so eager mode decides correctly.
      console.log(
        `  [${agentName}] Kill landed too late — run already ${killOutcome}; respecting existing status`,
      );
      return finish(killOutcome, workSessionId);
    }
    if (!workSessionId) {
      console.warn(`  [${agentName}] No session ID captured before kill — resume will start fresh`);
    }
    // Split (issue #15): a failed activity POST must not skip the status PUT
    // that records the kill — otherwise the run stays 'running'.
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content:
          "Run killed by user. Comment on this run to resume — the CLI session was saved and the agent will pick back up with full context.",
      });
    } catch (err) {
      console.error(`  [${agentName}] Failed to post kill activity: ${err.message}`);
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
    } catch (err) {
      console.error(`  [${agentName}] Failed to finalize kill status: ${err.message}`);
    }
    console.log(`  [${agentName}] Run ${runId} killed.`);
    // The agent turn ran, so informational postrun fires (cleanup on kill);
    // preserveSession keeps the session saved for a later resume-via-comment.
    return finish("killed", workSessionId, { preserveSession: true });
  }

  // ---- CLI hard error -------------------------------------------------------
  // Non-zero exit: the session may be broken, so we do NOT attempt finalize —
  // we fail directly (as today). The kill path above already returned.
  if (result.code !== 0) {
    console.error(`  [${agentName}] CLI exited with code ${result.code}`);

    let reason;
    if (result.timedOut) {
      const mins = Math.round(CLI_INACTIVITY_TIMEOUT_MS / 60000);
      reason = `Process killed after ${mins} minute(s) with no output — the CLI stalled (startup hang, or a blocked call that never returned).`;
    } else if (result.code === 143) {
      reason = `Process was killed (SIGTERM) before the CLI exited cleanly.`;
    } else if (result.code === 137) {
      reason = `Process was force-killed (SIGKILL) — out of memory, or it ignored SIGTERM.`;
    } else {
      reason = `CLI exited with code ${result.code}.`;
    }

    // Filter out raw streaming protocol lines from stdout — keep only readable content
    const sanitizedOutput = output
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "stream_event" || obj.type === "assistant" || obj.type === "system")
            return false;
        } catch {
          /* not JSON — keep it */
        }
        return true;
      })
      .join("\n")
      .trim();

    let errorContent = `**${reason}**`;
    if (result.stderr?.trim()) errorContent += `\n\nstderr:\n${result.stderr.trim()}`;
    if (sanitizedOutput) errorContent += `\n\nOutput:\n${sanitizedOutput}`;
    if (errorContent.length > 4000) errorContent = errorContent.slice(-4000);

    // Independent best-effort calls (issue #15) — see the CLI-spawn path above.
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errorContent });
    } catch {
      /* best effort */
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch {
      /* best effort */
    }

    return finish("failed", workSessionId);
  }

  // ---- Post work output -----------------------------------------------------
  const truncatedOutput = output.length > 50000 ? output.slice(-50000) : output;
  try {
    await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
      content: truncatedOutput,
    });
  } catch (err) {
    console.error(`  [${agentName}] Failed to post activity: ${err.message}`);
  }

  // ---- Status check + finalize turn (issue #34) -----------------------------
  // The work prompt no longer mandates a final status. If the agent already set
  // a valid terminal value (e.g. `waiting` mid-run), we're done. Otherwise the
  // harness DRIVES a finalize turn: resume the same session with a tight prompt
  // asking only for a status, re-check, repeat up to FINALIZE_MAX_ATTEMPTS, and
  // force `failed` on exhaustion as a backstop.
  let currentStatus = "running";
  try {
    const run = await apiCall(`${url}/api/runs/${runId}/status`, apiKey);
    currentStatus = run.status;
  } catch {
    /* best effort — fall through to finalize */
  }

  if (!shouldRunFinalize(currentStatus)) {
    return finish(currentStatus, workSessionId);
  }

  const finalized = await runFinalizeLoop({
    provider,
    url,
    apiKey,
    runId,
    agentName,
    sessionId: workSessionId,
    model: agentModel,
    thinking: agentThinking,
    workingDir,
    extraEnv: payload.env || {},
    activityContext: truncatedOutput,
    api: payload.api,
  });

  return finish(finalized.outcome, finalized.sessionId || workSessionId);
}

/**
 * Drive the finalize loop: make the run set a valid terminal status by
 * execution rather than prompt-advice. Resumes the SAME CLI session when
 * possible (full context of the work just done); falls back to a fresh turn
 * carrying the activity log when there's no resumable session.
 *
 * Returns { outcome, sessionId } where outcome is a terminal status. On
 * exhaustion the outcome is `failed` with a system note (backstop).
 *
 * Model: reuses the job's already-resolved model (issue #34 decision — no
 * separate finalize_model field yet). The invocation is structured so an
 * override could be slotted in trivially (swap `model` here).
 */
async function runFinalizeLoop({
  provider,
  url,
  apiKey,
  runId,
  agentName,
  sessionId,
  model,
  thinking,
  workingDir,
  extraEnv,
  activityContext,
  api,
}) {
  // `api` is required to build the status-endpoint curl. Without it we can't
  // tell the agent how to set status — fail with the backstop note.
  if (!api) {
    await failFinalize({ url, apiKey, runId, agentName, sessionId });
    return { outcome: "failed", sessionId };
  }

  const { mode } = resolveFinalizeMode(provider, sessionId);
  let turnSessionId = sessionId;

  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt++) {
    console.log(
      `  [${agentName}] Finalize attempt ${attempt}/${FINALIZE_MAX_ATTEMPTS} (${mode}) — asking for a terminal status`,
    );

    const finalizePrompt = buildFinalizePrompt(api, apiKey, { mode, activityContext });
    // Resume mode reuses the session (isNewSession=false). Fresh mode runs a new
    // turn with no session id; the prompt carries the activity log as context.
    const cmd =
      mode === "resume"
        ? provider.buildCommand(finalizePrompt, model, workingDir, turnSessionId, false, thinking)
        : provider.buildCommand(finalizePrompt, model, workingDir, null, true, thinking);

    try {
      const turn = await runCliTurn({
        cmd,
        provider,
        url,
        apiKey,
        runId,
        agentName,
        sessionId: turnSessionId,
        extraEnv,
        sessionAlreadyReported: true,
      });
      if (turn.sessionId) turnSessionId = turn.sessionId;
      // A kill during finalize is honored as a kill outcome (user said stop) —
      // UNLESS the agent set a terminal status during this turn before the kill
      // landed, in which case forcing `killed` would be an illegal transition
      // (e.g. done → killed). resolveKillOutcome respects an existing terminal
      // status and only PUTs `killed` for a genuine running→killed kill.
      if (turn.killed) {
        const killOutcome = resolveKillOutcome(turn.statusAtKill);
        if (killOutcome === "killed") {
          try {
            await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
          } catch {
            /* best effort */
          }
        }
        return { outcome: killOutcome, sessionId: turnSessionId };
      }
    } catch (err) {
      console.error(`  [${agentName}] Finalize turn failed: ${err.message}`);
      // Treat a finalize CLI failure like a non-compliant attempt and let the
      // loop's exhaustion backstop decide.
    }

    let status = "running";
    try {
      const run = await apiCall(`${url}/api/runs/${runId}/status`, apiKey);
      status = run.status;
    } catch {
      /* best effort */
    }

    const step = finalizeStep({ status, attempt });
    if (step.done) {
      if (step.forced) {
        await failFinalize({ url, apiKey, runId, agentName, sessionId: turnSessionId });
        return { outcome: "failed", sessionId: turnSessionId };
      }
      console.log(`  [${agentName}] Finalize: agent set status "${step.outcome}"`);
      return { outcome: step.outcome, sessionId: turnSessionId };
    }
  }

  // Defensive: loop fell through without finalizeStep returning done (shouldn't
  // happen — the last attempt always forces). Keep the backstop.
  await failFinalize({ url, apiKey, runId, agentName, sessionId: turnSessionId });
  return { outcome: "failed", sessionId: turnSessionId };
}

/**
 * Run the postrun gate (#29) for a finished run, AFTER its status is finalized.
 * The symmetric twin of the prerun gate. Pure decisions live in shouldRunPostrun
 * / postrunStatusOverride (unit-tested); this is the thin shell that:
 *   1. decides whether to fire (no command / pure prerun-skip / wrong outcome → no-op),
 *   2. runs the command with the same scaffolding prerun uses (runGateCommand:
 *      ~/.harbour/workflows cwd, payload+activity on stdin, kill-poll/timeout),
 *   3. captures the gate's output as an activity entry,
 *   4. in enforcing mode only, applies a done -> failed override on nonzero exit.
 *
 * Returns the resolved terminal outcome (== the input outcome unless the
 * enforcing gate overrode it).
 *
 * @param {object} args
 * @param {object} args.job        - the run's job (reads .postrun / .postrun_gates)
 * @param {string} args.outcome    - the finalized terminal status
 * @param {boolean} args.agentRan  - did the agent work turn execute?
 * @param {string} args.url        - Harbour base URL
 * @param {string} args.apiKey     - agent API key
 * @param {string} args.runId     - the run being finalized
 * @param {string} args.agentName  - for log prefixes
 * @param {Record<string, string>} args.env - decrypted run env vars for the gate command
 * @param {string} args.payloadJson - run payload + activity, piped to stdin
 * @param {number} [args.killPollIntervalMs] - kill-poll cadence override (tests)
 */
export async function runPostrun({
  job,
  outcome,
  agentRan,
  url,
  apiKey,
  runId,
  agentName,
  env,
  payloadJson,
  killPollIntervalMs,
}) {
  const command = job?.postrun;
  const gates = !!job?.postrun_gates;

  if (!shouldRunPostrun({ command, outcome, gates, agentRan })) return outcome;

  const mode = gates ? "enforcing" : "informational";
  console.log(`  [${agentName}] Postrun (${mode}) — running for run ${runId} [${outcome}]`);

  let wfResult;
  try {
    wfResult = await runGateCommand({
      command,
      payloadJson,
      url,
      apiKey,
      runId,
      agentName,
      label: "Postrun",
      extraEnv: env,
      killPollIntervalMs,
    });
  } catch (err) {
    console.error(`  [${agentName}] Postrun command failed: ${err.message}`);
    // A postrun that can't even run: surface it, and in enforcing mode treat the
    // unverifiable result as a failure (same as a nonzero exit). Informational
    // mode swallows it (never changes status).
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Postrun error: ${err.message}`,
      });
    } catch {
      /* best effort */
    }
    const { status } = postrunStatusOverride({ gates, code: 1, outcome });
    if (status) {
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status });
      } catch {
        /* best effort */
      }
      return status;
    }
    return outcome;
  }

  // A kill during postrun: the run is ALREADY terminal (postrun runs after status
  // finalization), so it cannot be re-finalized to `killed` — done/failed/skipped
  // -> killed are all illegal transitions, and killed -> killed is a no-op. The
  // run is finished; only postrun cleanup was still executing. Honor the existing
  // outcome (postrunKillStatus -> never a status PUT) and note that the kill
  // landed after completion. Don't apply any gate override on top of it.
  if (wfResult.killed) {
    const { status } = postrunKillStatus({ outcome });
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Kill requested during postrun, but the run had already finished (${outcome}) — postrun cleanup was stopped; the run's status is unchanged.`,
      });
    } catch {
      /* best effort */
    }
    if (status) {
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status });
      } catch {
        /* best effort */
      }
    }
    console.log(
      `  [${agentName}] Postrun kill landed after completion — keeping status ${outcome}`,
    );
    return status || outcome;
  }

  // Capture the gate's output (informational and enforcing both log it).
  const gateOutput = wfResult.stdout?.trim() || wfResult.stderr?.trim() || "";
  const { status: override } = postrunStatusOverride({ gates, code: wfResult.code, outcome });

  if (override) {
    // Enforcing gate failed verification: surface the stderr as the reason and
    // override done -> failed (the edge updateRunStatus reserves for the gate).
    const reason =
      wfResult.stderr?.trim() ||
      wfResult.stdout?.trim() ||
      `Postrun gate exited with code ${wfResult.code}`;
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Postrun gate failed (exit ${wfResult.code}):\n${reason}`,
      });
    } catch {
      /* best effort */
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: override });
    } catch {
      /* best effort */
    }
    console.log(`  [${agentName}] Postrun gate override: ${outcome} -> ${override}`);
    return override;
  }

  // No override (informational mode, or enforcing gate passed): just log output.
  if (gateOutput) {
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Postrun output:\n${gateOutput}`,
      });
    } catch {
      /* best effort */
    }
  }
  return outcome;
}

/** Backstop: force `failed` with a system note when finalize is exhausted. */
async function failFinalize({ url, apiKey, runId, agentName }) {
  console.warn(
    `  [${agentName}] Finalize exhausted — forcing failed (agent never set a valid status)`,
  );
  try {
    await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
      content: "Run marked as failed: agent did not set a final status after the finalize turn.",
    });
  } catch {
    /* best effort */
  }
  try {
    await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
  } catch {
    /* best effort */
  }
}

/**
 * Top-level driver for a single runner. Polls /next once per iteration; if the
 * agent has eager polling enabled and the run finished cleanly (done/waiting/
 * skipped), immediately polls again instead of waiting for the next launchd
 * tick. Bails on no-work, poll errors, kills, and failures.
 */
async function runSingleAgent(runner) {
  for (let i = 0; i < EAGER_MAX_ITERATIONS; i++) {
    const { outcome, eager } = await processNextRun(runner);
    if (!shouldContinueEagerLoop(outcome, eager)) return;
    console.log(`  [${runner.name}] Eager: continuing to next run (iter ${i + 1})...`);
  }
  console.warn(
    `  [${runner.name}] Hit eager iteration cap (${EAGER_MAX_ITERATIONS}) — exiting cycle`,
  );
}

/**
 * Map a finished workflow command to its terminal run status.
 * Exit 0 = done, 77 = skip, any other non-zero = failed. A kill only wins when
 * the command did NOT exit cleanly — a clean exit 0 that races a late kill
 * request still counts as success, so a completed run is never mislabeled
 * `killed`.
 *
 * @param {{ killed: boolean, code: number|null }} result
 * @returns {'killed'|'skipped'|'done'|'failed'}
 */
export function workflowOutcome({ killed, code }) {
  if (killed && code !== 0) return "killed";
  if (code === 77) return "skipped";
  if (code === 0) return "done";
  return "failed";
}

export async function processNextWorkflow(runner, opts = {}) {
  const { killPollIntervalMs = KILL_POLL_INTERVAL_MS } = opts;
  const { apiKey, name = "workflow", url } = runner;
  console.log(`  [${name}] Polling workflows...`);

  let payload;
  try {
    payload = await apiCall(`${url}/api/workflows/next`, apiKey);
  } catch (err) {
    console.error(`  [${name}] Workflow poll failed: ${err.message}`);
    return { outcome: "poll-error" };
  }

  if (!payload?.run) {
    console.log(`  [${name}] No workflow work.`);
    return { outcome: "no-work" };
  }

  const runId = payload.run.id;
  console.log(`  [${name}] Starting workflow run ${runId} (${payload.job?.name || "unnamed"})`);

  const command = payload.job?.command || payload.job?.workflow;
  if (!command) {
    console.error(`  [${name}] No workflow command — failing`);
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch {
      /* best effort */
    }
    return { outcome: "failed" };
  }

  const workflowDir = join(process.env.HARBOUR_HOME || join(homedir(), ".harbour"), "workflows");
  mkdirSync(workflowDir, { recursive: true });

  const workflowTimeoutMs = (payload.job.timeout_minutes || 30) * 60 * 1000;

  // Kill polling
  const killController = new AbortController();
  let killed = false;
  const killPoll = setInterval(async () => {
    if (killed) return;
    try {
      const res = await apiCall(`${url}/api/runs/${runId}/kill`, apiKey);
      if (res?.kill_requested) {
        killed = true;
        killController.abort();
        console.log(`  [${name}] Kill requested — stopping`);
      }
    } catch {
      /* best effort */
    }
  }, killPollIntervalMs);

  // Run-scoped env handed to the script. HARBOUR_* let a script post live
  // progress updates to its own Output log while it runs (workflow runs have
  // no message thread — these breadcrumbs are the only mid-run visibility):
  //   curl -X POST "$HARBOUR_URL/api/runs/$HARBOUR_RUN_ID/activity" \
  //     -H "Authorization: Bearer $HARBOUR_API_KEY" -d '{"content":"..."}'
  // Job-linked env vars are layered in first (parity with agent runs, so
  // scripts can expand `$SECRET`); HARBOUR_* win on any name collision.
  const extraEnv = {
    ...(payload.env || {}),
    HARBOUR_RUN_ID: runId,
    HARBOUR_API_KEY: apiKey,
    HARBOUR_URL: url,
  };

  try {
    const wfResult = await runWorkflow(command, JSON.stringify(payload), workflowDir, {
      timeoutMs: workflowTimeoutMs,
      signal: killController.signal,
      extraEnv,
    });
    clearInterval(killPoll);

    // A kill only wins if the command didn't already exit cleanly — see
    // workflowOutcome. This stops a successful run that finished in the kill
    // poll window from being mislabeled `killed`.
    const outcome = workflowOutcome({ killed, code: wfResult.code });

    if (outcome === "killed") {
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
      } catch {
        /* best effort */
      }
      return { outcome: "killed" };
    }

    if (outcome === "skipped") {
      console.log(`  [${name}] Workflow exited 77 — skipping`);
      if (wfResult.stderr?.trim()) {
        try {
          await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
            content: wfResult.stderr.trim(),
          });
        } catch {
          /* best effort */
        }
      }
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "skipped" });
      } catch {
        /* best effort */
      }
      return { outcome: "skipped" };
    }

    if (outcome === "failed") {
      console.error(`  [${name}] Workflow exited ${wfResult.code} — failed`);
      const errOutput =
        wfResult.stderr?.trim() ||
        wfResult.stdout?.trim() ||
        `Workflow exited with code ${wfResult.code}`;
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errOutput });
      } catch {
        /* best effort */
      }
      try {
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch {
        /* best effort */
      }
      return { outcome: "failed" };
    }

    // Exit 0 — success
    const output = wfResult.stdout?.trim();
    if (output) {
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: output });
      } catch {
        /* best effort */
      }
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "done" });
    } catch {
      /* best effort */
    }
    console.log(`  [${name}] Workflow run ${runId} completed.`);
    return { outcome: "done" };
  } catch (err) {
    clearInterval(killPoll);
    console.error(`  [${name}] Workflow command failed: ${err.message}`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Workflow error: ${err.message}`,
      });
    } catch {
      /* best effort */
    }
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch {
      /* best effort */
    }
    return { outcome: "failed" };
  }
}

async function runSingleWorkflowRunner(runner) {
  for (let i = 0; i < EAGER_MAX_ITERATIONS; i++) {
    const { outcome } = await processNextWorkflow(runner);
    if (outcome !== "done" && outcome !== "skipped") return;
    console.log(`  [${runner.name}] Continuing to next workflow (iter ${i + 1})...`);
  }
  console.warn(
    `  [${runner.name}] Hit workflow iteration cap (${EAGER_MAX_ITERATIONS}) — exiting cycle`,
  );
}

export async function runAgents() {
  const runners = loadRunnerConfigs();
  if (runners.length === 0) {
    console.log("No harbour agents configured. Create one from the dashboard.");
    return;
  }

  console.log(`Polling ${runners.length} harbour agent(s)...`);

  const work = [];
  for (const runner of runners) {
    work.push(runSingleAgent(runner));
  }

  await Promise.allSettled(work);

  console.log("Done.");
}

export async function runWorkflows() {
  const runners = loadWorkflowRunnerConfigs();
  if (runners.length === 0) {
    console.log(
      "No harbour workflow runners configured. Create and connect one from the dashboard.",
    );
    return;
  }

  console.log(`Polling ${runners.length} harbour workflow runner(s)...`);
  await Promise.allSettled(runners.map(runSingleWorkflowRunner));
  console.log("Done.");
}
