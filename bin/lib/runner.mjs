import { loadRunnerConfigs, loadWorkflowRunnerConfigs, loadSessions, saveSessions } from "./config.mjs";
import { getProvider, ensureWorkingDir, runCliTool, resolveRunConfig } from "./providers.mjs";
import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

async function apiCall(url, apiKey, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
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

function buildApiPrompt(api, apiKey) {
  const setTitleUrl = api.endpoints.set_title?.replace("PUT ", "") || "";
  const runStatusUrl = api.endpoints.update_status.replace("PUT ", "");
  const activityUrl = api.endpoints.post_activity.replace("POST ", "");
  const uploadUrl = api.endpoints.upload_attachment?.replace("POST ", "") || "";
  const guideUrl = api.endpoints.guide.replace("GET ", "");

  return `## Harbour API

Your output will be posted as a comment on this run. Write a clear, concise summary.

Before doing anything else, set a short title for this run (max 80 chars) so humans can identify it on the dashboard:
  curl -X PUT ${setTitleUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"title":"your short title"}'

You MUST set a final run status when finished. If you don't, the run will be marked as failed.
Use these curl commands with the provided API key:

Set status to done (completed successfully):
  curl -X PUT ${runStatusUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"status":"done"}'

Set status to waiting (you need human input — explain what you need in an activity message first):
  curl -X PUT ${runStatusUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"status":"waiting"}'

Set status to failed (something went wrong):
  curl -X PUT ${runStatusUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"status":"failed"}'

Post an activity message (visible on dashboard):
  curl -X POST ${activityUrl} -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"content":"your message"}'

Upload an attachment (file) to this run:
  curl -X POST ${uploadUrl} -H "Authorization: Bearer ${apiKey}" -F "file=@/path/to/file.png"

Download an attachment file (use the url shown in the Attachments section):
  curl -H "Authorization: Bearer ${apiKey}" -o /tmp/file.png "<attachment url>"

Full API spec (docs, databases, etc): ${guideUrl}
`;
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
        out.push(`[${a.author_type}] attached ${linked.length} ${linked.length === 1 ? "attachment" : "attachments"}:`);
        out.push(renderAttachmentList(linked, "  "));
      }
      out.push("");
    }
    return out.join("\n").trim();
  }

  if (isResume) {
    const activity = payload.run.activity || [];
    const lastAgentIdx = activity.findLastIndex(a => a.author_type === "agent");
    const newEntries = lastAgentIdx >= 0 ? activity.slice(lastAgentIdx + 1) : activity;
    const humanEntries = newEntries.filter(a => a.author_type === "user" || a.author_type === "system");

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
      if (columns?.length) prompt += `columns: ${columns.map(c => `${c.name} (${c.type})`).join(", ")}\n`;
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

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => {
      if (postExitTimer) clearTimeout(postExitTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });
    child.on("exit", () => {
      postExitTimer = setTimeout(() => {
        if (closeFired) return;
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
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
        try { child.kill("SIGTERM"); } catch {}
        sigkillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, killGraceMs);
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
    } catch { /* pipe already closed */ }
  });
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

  if (!payload || !payload.run) {
    console.log(`  [${agentName}] Nothing to do.`);
    return { outcome: "no-work", eager: false };
  }

  // cli/model/thinking come live from the /next payload (harbour is the source
  // of truth); the runner config is identity-only but may carry legacy values
  // as a fallback. Resolve before anything that needs the provider.
  const { cli, model: agentModel, thinking: agentThinking } = resolveRunConfig(payload, runner);
  if (!cli) {
    console.error(`  [${agentName}] No CLI configured for this agent — set one in the dashboard.`);
    return { outcome: "config-error", eager: false };
  }
  const provider = getProvider(cli);

  // Live eager flag from server, falling back to cached runner config
  const eager = payload.agent?.eager !== undefined ? !!payload.agent.eager : !!runner.eager;

  const runId = payload.run.id;
  const existingSession = sessions[runId];
  const isResume = !!existingSession;
  let sessionId = existingSession?.sessionId || null;
  const isNewSession = !isResume;

  // For Claude, generate a session ID upfront so we can always resume
  const workingDir = ensureWorkingDir(agentName);
  if (isNewSession && provider.generateSessionId) {
    sessionId = provider.generateSessionId();
    // Report pre-generated session ID immediately
    apiCall(`${url}/api/runs/${runId}/session`, apiKey, "PUT", { session_id: sessionId, cwd: workingDir })
      .catch(err => console.error(`  [${agentName}] Failed to report session ID: ${err.message}`));
  }

  console.log(`  [${agentName}] ${isResume ? "Resuming" : "Starting"} run ${runId} (${payload.job?.name || "one-off"})`);

  // Execute agent prerun command (if defined). This is a cheap gate to avoid
  // spending LLM tokens when there is no work.
  let prerunOutput = "";
  if (!isResume && payload.job?.prerun) {
    const prerunDir = join(process.env.HARBOUR_HOME || join(homedir(), ".harbour"), "workflows");
    mkdirSync(prerunDir, { recursive: true });

    const prerunTimeoutMs = 30_000;

    // Kill polling for prerun execution
    const workflowKillController = new AbortController();
    let workflowKilled = false;
    const workflowKillPoll = setInterval(async () => {
      if (workflowKilled) return;
      try {
        const res = await apiCall(`${url}/api/runs/${runId}/kill`, apiKey);
        if (res?.kill_requested) {
          workflowKilled = true;
          workflowKillController.abort();
          console.log(`  [${agentName}] Kill requested during prerun — stopping`);
        }
      } catch { /* best effort */ }
    }, KILL_POLL_INTERVAL_MS);

    try {
      const wfResult = await runWorkflow(payload.job.prerun, JSON.stringify(payload), prerunDir, {
        timeoutMs: prerunTimeoutMs,
        signal: workflowKillController.signal,
      });
      clearInterval(workflowKillPoll);

      if (workflowKilled) {
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
        } catch { /* best effort */ }
        return { outcome: "killed", eager };
      }

      if (wfResult.code === 77) {
        // Skip — no work to do
        console.log(`  [${agentName}] Prerun exited 77 — skipping`);
        if (wfResult.stderr?.trim()) {
          try {
            await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: wfResult.stderr.trim() });
          } catch { /* best effort */ }
        }
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "skipped" });
        } catch { /* best effort */ }
        return { outcome: "skipped", eager };
      }

      if (wfResult.code !== 0) {
        // Error — any non-zero except 77
        console.error(`  [${agentName}] Prerun exited ${wfResult.code} — failed`);
        const errOutput = wfResult.stderr?.trim() || wfResult.stdout?.trim() || `Prerun exited with code ${wfResult.code}`;
        try {
          await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errOutput });
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
        } catch { /* best effort */ }
        return { outcome: "failed", eager };
      }

      // Exit 0 — success, capture output for prompt context
      prerunOutput = wfResult.stdout?.trim() || "";
    } catch (err) {
      clearInterval(workflowKillPoll);
      console.error(`  [${agentName}] Prerun command failed: ${err.message}`);
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: `Prerun error: ${err.message}` });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return { outcome: "failed", eager };
    }
  }

  // Build prompt — append prerun output as additional context
  let prompt = buildPrompt(payload, apiKey, isResume);
  if (prerunOutput) {
    prompt += `## Prerun Output\n\n${prerunOutput}\n\n`;
  }

  // model/thinking were already resolved (job override > agent default) above.
  const cmd = provider.buildCommand(prompt, agentModel, workingDir, sessionId, isNewSession, agentThinking);

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
    } catch { /* best effort — server may be restarting */ }
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
  const parser = provider.createParser
    ? provider.createParser()
    : provider;

  // Line handler: parse each JSONL line from the CLI tool
  let sessionReported = !!sessionId; // already reported if pre-generated
  function onLine(line) {
    if (!parser.parseLine) return;
    const parsed = parser.parseLine(line);
    if (!parsed) return;

    // Capture session ID from init events
    if (parsed.sessionId && !sessionId) {
      sessionId = parsed.sessionId;
    } else if (parsed.sessionId) {
      sessionId = parsed.sessionId;
    }

    // Report session ID to the server (once) so it's available on the dashboard
    if (sessionId && !sessionReported) {
      sessionReported = true;
      apiCall(`${url}/api/runs/${runId}/session`, apiKey, "PUT", { session_id: sessionId, cwd: workingDir })
        .catch(err => console.error(`  [${agentName}] Failed to report session ID: ${err.message}`));
    }

    for (const evt of parsed.events) {
      queueEvent(evt);
    }
  }

  // Execute CLI tool with streaming (use per-job timeout, fallback to 30 min)
  const timeoutMinutes = payload.job?.timeout_minutes || 30;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let result;
  try {
    result = await runCliTool(cmd.binary, cmd.args, cmd.cwd, {
      timeoutMs,
      onLine,
      signal: killController.signal,
      extraEnv: payload.env || {},
    });
  } catch (err) {
    clearInterval(killPollTimer);
    console.error(`  [${agentName}] CLI execution failed: ${err.message}`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Runner error: CLI tool "${cli}" failed to execute: ${err.message}`,
      });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    return { outcome: "failed", eager };
  }

  clearInterval(killPollTimer);

  // Flush any remaining buffered events
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushEvents();

  // Handle user-initiated kill: save session, post activity, set status=killed,
  // and bail before the normal "did agent set final status?" failsafe below
  // (which would otherwise overwrite killed → failed).
  if (killed) {
    // Race: agent may have finished naturally in the tiny window between
    // kill request and SIGTERM landing. If the server already has a terminal
    // status, respect it — the kill was moot.
    let statusAtKill = "running";
    try {
      const run = await apiCall(`${url}/api/runs/${runId}/status`, apiKey);
      statusAtKill = run.status;
    } catch { /* best effort */ }

    if (["done", "waiting", "skipped", "failed"].includes(statusAtKill)) {
      console.log(`  [${agentName}] Kill landed too late — run already ${statusAtKill}; respecting existing status`);
      // Save session for waiting (normal behavior), clean up otherwise.
      if (statusAtKill === "waiting") {
        const parsedLate = provider.parseResult(result.stdout, sessionId);
        const lateSessionId = parsedLate.sessionId || sessionId;
        if (lateSessionId) {
          sessions[runId] = { sessionId: lateSessionId, cli };
          saveSessions(sessions);
        }
      } else {
        delete sessions[runId];
        saveSessions(sessions);
      }
      // Race: agent finished before kill landed — report the actual final
      // status so eager mode can decide correctly (done/waiting/skipped → continue,
      // failed → exit).
      return { outcome: statusAtKill, eager };
    } else {
      const parsedOnKill = provider.parseResult(result.stdout, sessionId);
      const killSessionId = parsedOnKill.sessionId || sessionId;
      if (killSessionId) {
        sessions[runId] = { sessionId: killSessionId, cli };
        saveSessions(sessions);
        console.log(`  [${agentName}] Session saved for resume: ${killSessionId}`);
      } else {
        console.warn(`  [${agentName}] No session ID captured before kill — resume will start fresh`);
      }
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
          content: "Run killed by user. Comment on this run to resume — the CLI session was saved and the agent will pick back up with full context.",
        });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" });
      } catch (err) {
        console.error(`  [${agentName}] Failed to finalize kill: ${err.message}`);
      }
      console.log(`  [${agentName}] Run ${runId} killed.`);
      return { outcome: "killed", eager };
    }
  }

  // Parse final result for activity summary
  const parsed = provider.parseResult(result.stdout, sessionId);
  const output = parsed.content || result.stdout || result.stderr || "(no output)";
  const newSessionId = parsed.sessionId || sessionId;

  // Check if CLI exited with error
  if (result.code !== 0) {
    console.error(`  [${agentName}] CLI exited with code ${result.code}`);

    // Build a human-readable error reason
    let reason;
    if (result.code === 143) {
      reason = `Process was killed (SIGTERM) — likely hit the ${timeoutMinutes}-minute timeout before the CLI exited cleanly.`;
    } else if (result.code === 137) {
      reason = `Process was force-killed (SIGKILL) — out of memory or hard timeout.`;
    } else {
      reason = `CLI exited with code ${result.code}.`;
    }

    // Filter out raw streaming protocol lines from stdout — keep only readable content
    const sanitizedOutput = output
      .split("\n")
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        // Skip raw JSONL streaming protocol lines
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "stream_event" || obj.type === "assistant" || obj.type === "system") return false;
        } catch { /* not JSON — keep it */ }
        return true;
      })
      .join("\n")
      .trim();

    // Combine reason + stderr + any remaining meaningful output
    let errorContent = `**${reason}**`;
    if (result.stderr?.trim()) errorContent += `\n\nstderr:\n${result.stderr.trim()}`;
    if (sanitizedOutput) errorContent += `\n\nOutput:\n${sanitizedOutput}`;
    if (errorContent.length > 4000) errorContent = errorContent.slice(-4000);

    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: errorContent,
      });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }

    delete sessions[runId];
    saveSessions(sessions);
    return { outcome: "failed", eager };
  }

  // Post output as activity (high-level summary)
  const truncatedOutput = output.length > 50000 ? output.slice(-50000) : output;
  try {
    await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
      content: truncatedOutput,
    });
  } catch (err) {
    console.error(`  [${agentName}] Failed to post activity: ${err.message}`);
  }

  // Check if the agent already set a terminal status (done/failed/waiting/skipped).
  // If not, the agent didn't follow the instructions — mark as failed.
  let currentStatus = "running";
  try {
    const run = await apiCall(`${url}/api/runs/${runId}/status`, apiKey);
    currentStatus = run.status;
  } catch { /* best effort — fall through to failsafe */ }

  const terminalStatuses = ["done", "failed", "waiting", "skipped"];
  if (!terminalStatuses.includes(currentStatus)) {
    console.warn(`  [${agentName}] Agent did not set a final status (still "${currentStatus}") — marking as failed`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: "Run marked as failed: agent did not set a final status.",
      });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    currentStatus = "failed";
  }

  // Save session for resume if waiting, clean up otherwise
  if (newSessionId && currentStatus === "waiting") {
    sessions[runId] = { sessionId: newSessionId, cli };
    saveSessions(sessions);
  } else {
    delete sessions[runId];
    saveSessions(sessions);
  }

  console.log(`  [${agentName}] Run ${runId} completed with status: ${currentStatus}`);
  return { outcome: currentStatus, eager };
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
  console.warn(`  [${runner.name}] Hit eager iteration cap (${EAGER_MAX_ITERATIONS}) — exiting cycle`);
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

  if (!payload || !payload.run) {
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
    } catch { /* best effort */ }
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
    } catch { /* best effort */ }
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
      try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" }); } catch { /* best effort */ }
      return { outcome: "killed" };
    }

    if (outcome === "skipped") {
      console.log(`  [${name}] Workflow exited 77 — skipping`);
      if (wfResult.stderr?.trim()) {
        try { await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: wfResult.stderr.trim() }); } catch { /* best effort */ }
      }
      try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "skipped" }); } catch { /* best effort */ }
      return { outcome: "skipped" };
    }

    if (outcome === "failed") {
      console.error(`  [${name}] Workflow exited ${wfResult.code} — failed`);
      const errOutput = wfResult.stderr?.trim() || wfResult.stdout?.trim() || `Workflow exited with code ${wfResult.code}`;
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errOutput });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return { outcome: "failed" };
    }

    // Exit 0 — success
    const output = wfResult.stdout?.trim();
    if (output) {
      try { await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: output }); } catch { /* best effort */ }
    }
    try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "done" }); } catch { /* best effort */ }
    console.log(`  [${name}] Workflow run ${runId} completed.`);
    return { outcome: "done" };
  } catch (err) {
    clearInterval(killPoll);
    console.error(`  [${name}] Workflow command failed: ${err.message}`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: `Workflow error: ${err.message}` });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    return { outcome: "failed" };
  }
}

async function runSingleWorkflowRunner(runner) {
  for (let i = 0; i < EAGER_MAX_ITERATIONS; i++) {
    const { outcome } = await processNextWorkflow(runner);
    if (outcome !== "done" && outcome !== "skipped") return;
    console.log(`  [${runner.name}] Continuing to next workflow (iter ${i + 1})...`);
  }
  console.warn(`  [${runner.name}] Hit workflow iteration cap (${EAGER_MAX_ITERATIONS}) — exiting cycle`);
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
    console.log("No harbour workflow runners configured. Create and connect one from the dashboard.");
    return;
  }

  console.log(`Polling ${runners.length} harbour workflow runner(s)...`);
  await Promise.allSettled(runners.map(runSingleWorkflowRunner));
  console.log("Done.");
}
