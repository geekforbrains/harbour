import { loadRunnerConfigs, loadSessions, saveSessions } from "./config.mjs";
import { getProvider, ensureWorkingDir, runCliTool } from "./providers.mjs";
import { ensureSageRuntimeCoverage, evaluateCommandWithSage } from "./sage-guard.mjs";
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

function isFreeRouterModel(model) {
  return model === "auto" || model === "freellm/auto";
}

function shouldRetryWithLocalDefault(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  return result.code !== 0 && (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate-limited") ||
    text.includes("quota") ||
    text.includes("exhaust") ||
    text.includes("all models") ||
    text.includes("model_not_found") ||
    text.includes("provider_error") ||
    text.includes("no route")
  );
}

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

function shouldRunToolkitSearch(payload, isResume) {
  if (isResume) return false;
  const cli = payload.agent?.cli;
  return cli === "openclaw" || cli === "hermes";
}

function buildToolkitSearchPrompt() {
  return `## First-Spawn Toolkit Search

Before acting, search BORG's evolving toolkit libraries and load only the entries that match this run. Harbour refreshes and scopes these manifests immediately before OpenCLaw/Hermes spawn:

- Skills: /Users/davidk/Documents/Borg Interface/SKILLS/registry.yaml
- Plugins: /Users/davidk/Documents/Borg Interface/AGENT RESEARCH/agentops/libraries/plugins/registry.yaml
- Sub-agents: /Users/davidk/Documents/Borg Interface/AGENT RESEARCH/agentops/libraries/sub-agents/registry.yaml
- Policy: /Users/davidk/Documents/Borg Interface/AGENT RESEARCH/agentops/libraries/spawn-toolkit-search.md

SAGE runtime security is already enforced by Harbour before this agent runtime starts. Treat the runtime_security metadata as always-on control-plane state, not as an optional skill to load.

Use active global skills plus matching workspace/project/brand-kit skills. Select plugins only when the task, scope, and credential gates match. Search sub-agents only when delegation is explicitly requested or clearly useful for a control-plane workflow. Do not auto-install tools, spend money, deploy, send messages, or make destructive changes unless this run asks for that capability and the relevant approval gate is satisfied.

Mention the toolkit entries you selected in your final run summary.\n\n`;
}

function renderRuntimeSecurity(runtimeSecurity) {
  if (!runtimeSecurity?.provider) return "";
  const requiredFor = Array.isArray(runtimeSecurity.required_for)
    ? runtimeSecurity.required_for.join(", ")
    : String(runtimeSecurity.required_for || "");
  return [
    "## Runtime Security",
    "",
    `Provider: ${runtimeSecurity.provider}`,
    `Source: ${runtimeSecurity.source_repo || "unknown"}`,
    `Version: ${runtimeSecurity.version || "unknown"}`,
    `Enforcement: ${runtimeSecurity.enforcement || "unknown"}`,
    `Privacy: ${runtimeSecurity.privacy_profile || "unknown"}`,
    `Config: ${runtimeSecurity.config_path || "unknown"}`,
    requiredFor ? `Required for: ${requiredFor}` : null,
    "",
  ].filter(line => line !== null).join("\n");
}

function renderToolkitLibraryPacket(toolkit) {
  if (!toolkit?.libraries?.length) return "";
  let out = `## Fresh Toolkit Library Packet\n\n`;
  out += `Generated: ${toolkit.generated_at || "unknown"}\n`;
  out += `Orgo VM root: ${toolkit.orgo?.vm_root || "/opt/borg/toolkit-libraries"} (${toolkit.orgo?.mount_mode || "read-only"})\n\n`;
  for (const library of toolkit.libraries) {
    const entries = Array.isArray(library.entries) ? library.entries : [];
    out += `### ${library.label || library.id} (${entries.length})\n`;
    out += `Manifest: ${library.path || "unknown"}\n`;
    out += `VM mirror: ${library.vmPath || "unknown"}\n`;
    for (const entry of entries) {
      const scopes = entry.scope ? [entry.scope] : (entry.allowed_scopes || []);
      const meta = [
        entry.status && `status=${entry.status}`,
        entry.category && `category=${entry.category}`,
        scopes.length ? `scopes=${scopes.join("/")}` : null,
        entry.credential_status && `creds=${entry.credential_status}`,
        entry.load_policy && `load=${entry.load_policy}`,
        entry.risk_level && `risk=${entry.risk_level}`,
        entry.human_gate && `gate=${entry.human_gate}`,
      ].filter(Boolean).join("; ");
      const desc = (entry.description || entry.handoff_contract || "").replace(/\s+/g, " ").slice(0, 220);
      const triggers = Array.isArray(entry.triggers) && entry.triggers.length ? ` Triggers: ${entry.triggers.slice(0, 6).join(", ")}.` : "";
      out += `- ${entry.id}: ${entry.name}${meta ? ` [${meta}]` : ""}${desc ? ` — ${desc}` : ""}${triggers}\n`;
    }
    out += "\n";
  }
  return out;
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

  if (shouldRunToolkitSearch(payload, isResume)) {
    prompt += buildToolkitSearchPrompt();
    prompt += renderToolkitLibraryPacket(payload.toolkit_libraries);
  }

  if (payload.runtime_security) {
    prompt += renderRuntimeSecurity(payload.runtime_security);
  }

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
    for (const [name, rows] of Object.entries(payload.data)) {
      prompt += `### ${name}\n\n`;
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
    prompt += `## Environment Variables\n\nThese credential names are available in the process environment for this run. Use shell expansion such as \`$VARNAME\` when making API calls, but do not print, log, summarize, or export secret values.\n\n`;
    for (const key of Object.keys(payload.env)) {
      prompt += `- \`${key}\`: available in process env\n`;
    }
    prompt += "\n";
  }

  if (payload.skills?.length > 0) {
    prompt += `## Skill Library\n\nBefore acting, check these resolved skills and apply any that match the job. Use paths as source references when you need the full skill.\n\n`;
    for (const skill of payload.skills) {
      prompt += `### ${skill.name} (${skill.scope})\n`;
      if (skill.path) prompt += `Path: ${skill.path}\n`;
      if (skill.tags) prompt += `Tags: ${skill.tags}\n`;
      if (skill.triggers) prompt += `Triggers: ${skill.triggers}\n`;
      prompt += `${skill.digest || skill.description || "No digest available."}\n\n`;
    }
  }

  if (payload.agent?.composio?.cli_enabled || payload.agent?.composio?.mcp_enabled) {
    const toolkits = payload.agent.composio.toolkits || [];
    const tools = payload.agent.composio.tools || [];
    prompt += `## Composio Access\n\n`;
    if (payload.agent.composio.cli_enabled) {
      prompt += `Composio CLI is available. Prefer known slugs with \`composio execute <SLUG> -d '{...}'\`; use \`composio execute <SLUG> --get-schema\` when inputs are unclear; use \`composio search "<task>"\` only when the slug is unknown.\n`;
    }
    if (payload.agent.composio.mcp_enabled) {
      prompt += `Composio MCP is enabled for this agent. Use MCP tools when your runtime exposes them; fall back to the Composio CLI if MCP is unavailable.\n`;
      prompt += `MCP config snippet:\n\`\`\`json\n${JSON.stringify({
        mcpServers: {
          composio: {
            command: "composio",
            args: ["mcp", "start"],
            env: {
              COMPOSIO_TOOLKITS: toolkits.join(","),
              COMPOSIO_TOOLS: tools.join(","),
            },
          },
        },
      }, null, 2)}\n\`\`\`\n`;
    }
    if (toolkits.length > 0) prompt += `Allowed toolkits: ${toolkits.join(", ")}\n`;
    if (tools.length > 0) prompt += `Allowed tool slugs: ${tools.join(", ")}\n`;
    prompt += "\n";
  }

  // Workflow output is appended by the runner after executing the workflow command
  // (see runSingleAgent — workflows are run as shell processes, not by the LLM)

  prompt += apiPrompt;

  return prompt;
}

/**
 * Run a workflow command. Pipes the full payload JSON to stdin.
 * Exit 0 = success, exit 77 = skip (no work), any other non-zero = error.
 * Returns { code, stdout, stderr }.
 *
 * @param {object} opts
 * @param {number} [opts.timeoutMs] - timeout in milliseconds (30s for gate, job timeout for workflow-only)
 * @param {AbortSignal} [opts.signal] - abort signal for kill handling
 * @param {string} [opts.sessionId] - run/session id for SAGE audit context
 */
export async function runWorkflow(command, payloadJson, cwd, opts = {}) {
  const { timeoutMs = 30_000, signal } = opts;
  const sage = await evaluateCommandWithSage(command, {
    sessionId: opts.sessionId,
    agentRuntime: "harbour-workflow",
  });
  if (!sage.allowed) {
    throw new Error(`SAGE blocked workflow command before execution:\n${sage.message}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let closeFired = false;
    let postExitTimer = null;
    // Workflows can background processes (dev servers, docker) that inherit
    // our stdout/stderr. Guard against "close" never firing by destroying
    // the pipes shortly after the workflow process itself exits.
    const POST_EXIT_GRACE_MS = 2000;

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => {
      if (postExitTimer) clearTimeout(postExitTimer);
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
      resolve({ code, stdout, stderr });
    });

    // Kill on abort signal
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
      } else {
        signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      }
    }

    // Pipe the payload to stdin
    child.stdin.write(payloadJson);
    child.stdin.end();
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
 *   'skipped'    — workflow gate exited 77, or run skipped
 *   'failed'     — CLI/workflow error, agent didn't set status, etc.
 *   'killed'     — user requested kill mid-run
 * `eager` reflects the live `agent.eager` flag from the /next payload (or the
 * cached runner config if the payload didn't include one).
 */
async function processNextRun(runner) {
  const { agentId, apiKey, cli, model: agentModel, thinking: agentThinking, name: agentName, url } = runner;
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

  // Live eager flag from server, falling back to cached runner config
  const eager = payload.agent?.eager !== undefined ? !!payload.agent.eager : !!runner.eager;

  const runId = payload.run.id;
  const existingSession = sessions[runId];
  const isResume = !!existingSession;
  let sessionId = existingSession?.sessionId || null;
  const isNewSession = !isResume;
  const isWorkflowOnly = !!payload.job?.workflow_only;

  let provider = null;
  if (!isWorkflowOnly) {
    try {
      const coverage = await ensureSageRuntimeCoverage(cli);
      console.log(`  [${agentName}] SAGE runtime security active: ${coverage.detail}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [${agentName}] ${message}`);
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
          content: `SAGE runtime security blocked spawn: ${message}`,
        });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return { outcome: "failed", eager };
    }

    try {
      provider = getProvider(cli);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [${agentName}] ${message}`);
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
          content: `Runner error: CLI provider "${cli}" is not available after SAGE coverage checks: ${message}`,
        });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return { outcome: "failed", eager };
    }
  }

  // For Claude, generate a session ID upfront so we can always resume
  const workingDir = isWorkflowOnly ? null : ensureWorkingDir(agentName);
  if (!isWorkflowOnly && isNewSession && provider.generateSessionId) {
    sessionId = provider.generateSessionId();
    // Report pre-generated session ID immediately
    apiCall(`${url}/api/runs/${runId}/session`, apiKey, "PUT", { session_id: sessionId, cwd: workingDir })
      .catch(err => console.error(`  [${agentName}] Failed to report session ID: ${err.message}`));
  }

  console.log(`  [${agentName}] ${isResume ? "Resuming" : "Starting"} run ${runId} (${payload.job?.name || "one-off"})`);

  // Execute workflow command (if defined)
  let workflowOutput = "";
  if (!isResume && payload.job?.workflow) {
    const workflowDir = join(process.env.HARBOUR_HOME || join(homedir(), ".harbour"), "workflows");
    mkdirSync(workflowDir, { recursive: true });

    // Timeout: 30s for gate (workflow+agent), job timeout for workflow-only
    const workflowTimeoutMs = isWorkflowOnly
      ? (payload.job.timeout_minutes || 30) * 60 * 1000
      : 30_000;

    // Kill polling for workflow execution
    const workflowKillController = new AbortController();
    let workflowKilled = false;
    const workflowKillPoll = setInterval(async () => {
      if (workflowKilled) return;
      try {
        const res = await apiCall(`${url}/api/runs/${runId}/kill`, apiKey);
        if (res?.kill_requested) {
          workflowKilled = true;
          workflowKillController.abort();
          console.log(`  [${agentName}] Kill requested during workflow — stopping`);
        }
      } catch { /* best effort */ }
    }, KILL_POLL_INTERVAL_MS);

    try {
      const wfResult = await runWorkflow(payload.job.workflow, JSON.stringify(payload), workflowDir, {
        timeoutMs: workflowTimeoutMs,
        signal: workflowKillController.signal,
        sessionId: runId,
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
        console.log(`  [${agentName}] Workflow exited 77 — skipping`);
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
        console.error(`  [${agentName}] Workflow exited ${wfResult.code} — failed`);
        const errOutput = wfResult.stderr?.trim() || wfResult.stdout?.trim() || `Workflow exited with code ${wfResult.code}`;
        try {
          await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errOutput });
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
        } catch { /* best effort */ }
        return { outcome: "failed", eager };
      }

      // Exit 0 — success
      if (isWorkflowOnly) {
        // Workflow-only: log output and mark done
        const output = wfResult.stdout?.trim();
        if (output) {
          try {
            await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: output });
          } catch { /* best effort */ }
        }
        try {
          await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "done" });
        } catch { /* best effort */ }
        console.log(`  [${agentName}] Workflow-only run ${runId} completed.`);
        return { outcome: "done", eager };
      }

      // Workflow + agent: capture output for prompt context
      workflowOutput = wfResult.stdout?.trim() || "";
    } catch (err) {
      clearInterval(workflowKillPoll);
      console.error(`  [${agentName}] Workflow command failed: ${err.message}`);
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: `Workflow error: ${err.message}` });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return { outcome: "failed", eager };
    }
  }

  // Workflow-only jobs should have returned above; if we get here with no CLI, fail
  if (isWorkflowOnly) {
    console.error(`  [${agentName}] Workflow-only job has no workflow command — failing`);
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    return { outcome: "failed", eager };
  }

  // Build prompt — append workflow output as additional context
  let prompt = buildPrompt(payload, apiKey, isResume);
  if (workflowOutput) {
    prompt += `## Workflow Output\n\n${workflowOutput}\n\n`;
  }

  // Build CLI command — job-level model/thinking override agent defaults
  const model = payload.job?.model || agentModel;
  const thinking = payload.job?.thinking || agentThinking;
  let cmd = provider.buildCommand(prompt, model, workingDir, sessionId, isNewSession, thinking);

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
  const startupTimeoutMs = ["hermes", "openclaw"].includes(cli)
    ? Math.min(timeoutMs, 10 * 60 * 1000)
    : undefined;
  let result;
  try {
    result = await runCliTool(cmd.binary, cmd.args, cmd.cwd, {
      timeoutMs,
      startupTimeoutMs,
      onLine,
      signal: killController.signal,
      extraEnv: payload.env || {},
    });
    if (!killed && isFreeRouterModel(model) && shouldRetryWithLocalDefault(result)) {
      await flushEvents();
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
          content: "Free API router was unavailable or exhausted. Retrying once with the configured free local default model.",
        });
      } catch { /* best effort */ }
      cmd = provider.buildCommand(prompt, null, workingDir, sessionId, isNewSession, thinking);
      result = await runCliTool(cmd.binary, cmd.args, cmd.cwd, {
        timeoutMs,
        startupTimeoutMs,
        onLine,
        signal: killController.signal,
        extraEnv: payload.env || {},
      });
    }
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
      const run = await apiCall(`${url}/api/runs/${runId}`, apiKey);
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
    if (result.startupTimedOut) {
      reason = `Process produced no stdout within the startup window and was stopped. This usually means the CLI is waiting for auth, hanging during model startup, or not emitting output in headless mode.`;
    } else if (result.code === 143) {
      reason = `Process was killed (SIGTERM) — likely hit the ${timeoutMinutes}-minute timeout before the CLI exited cleanly.`;
    } else if (result.code === 137) {
      reason = `Process was force-killed (SIGKILL) — out of memory or hard timeout.`;
    } else if (result.rawCode === null && result.signal) {
      reason = `CLI exited after signal ${result.signal}.`;
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
    const run = await apiCall(`${url}/api/runs/${runId}`, apiKey);
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

async function runAgentlessWorkflows(url, apiKey) {
  console.log(`  [workflows] Polling...`);

  let payload;
  try {
    payload = await apiCall(`${url}/api/workflows/next`, apiKey);
  } catch (err) {
    console.error(`  [workflows] Poll failed: ${err.message}`);
    return;
  }

  if (!payload || !payload.run) {
    console.log(`  [workflows] Nothing to do.`);
    return;
  }

  const runId = payload.run.id;
  console.log(`  [workflows] Starting run ${runId} (${payload.job?.name || "unnamed"})`);

  if (!payload.job?.workflow) {
    console.error(`  [workflows] No workflow command — failing`);
    try {
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    return;
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
        console.log(`  [workflows] Kill requested — stopping`);
      }
    } catch { /* best effort */ }
  }, KILL_POLL_INTERVAL_MS);

  try {
    const wfResult = await runWorkflow(payload.job.workflow, JSON.stringify(payload), workflowDir, {
      timeoutMs: workflowTimeoutMs,
      signal: killController.signal,
      sessionId: runId,
    });
    clearInterval(killPoll);

    if (killed) {
      try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "killed" }); } catch { /* best effort */ }
      return;
    }

    if (wfResult.code === 77) {
      console.log(`  [workflows] Workflow exited 77 — skipping`);
      if (wfResult.stderr?.trim()) {
        try { await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: wfResult.stderr.trim() }); } catch { /* best effort */ }
      }
      try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "skipped" }); } catch { /* best effort */ }
      return;
    }

    if (wfResult.code !== 0) {
      console.error(`  [workflows] Workflow exited ${wfResult.code} — failed`);
      const errOutput = wfResult.stderr?.trim() || wfResult.stdout?.trim() || `Workflow exited with code ${wfResult.code}`;
      try {
        await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: errOutput });
        await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
      } catch { /* best effort */ }
      return;
    }

    // Exit 0 — success
    const output = wfResult.stdout?.trim();
    if (output) {
      try { await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: output }); } catch { /* best effort */ }
    }
    try { await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "done" }); } catch { /* best effort */ }
    console.log(`  [workflows] Run ${runId} completed.`);
  } catch (err) {
    clearInterval(killPoll);
    console.error(`  [workflows] Workflow command failed: ${err.message}`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", { content: `Workflow error: ${err.message}` });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
  }
}

// Workflow-only jobs (agentless) are meant to run on the server host, not on
// remote worker machines. If every configured runner points at a remote URL
// (non-localhost), we skip the /api/workflows/next poll so remote workers
// don't grab jobs intended for the server box.
function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
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

  // Poll workflow-only jobs only against URLs this host is "local" to.
  // A runner pointing at localhost means the server is on this machine, so
  // we own the workflow-only queue for that URL. Remote runners skip it.
  const localRunner = runners.find(r => isLocalUrl(r.url));
  if (localRunner) {
    work.push(runAgentlessWorkflows(localRunner.url, localRunner.apiKey));
  }

  await Promise.allSettled(work);

  console.log("Done.");
}
