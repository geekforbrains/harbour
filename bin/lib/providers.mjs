import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MIN_GLOBAL_SECRET_REDACTION_LENGTH = 4;

const EVENT_CONTENT_LIMITS = Object.freeze({
  text_delta: 16_000,
  thinking: 8_000,
  tool_start: 4_000,
  tool_end: 12_000,
  info: 2_000,
  result: 2_000,
  error: 2_000,
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace exact secret values before output leaves the runner process. Values
 * shorter than four characters are too low-entropy for safe global substring
 * replacement (`1` would corrupt every token count and version), so they are
 * redacted only when delimited as standalone tokens. Longer values keep the
 * stronger anywhere-in-output behavior.
 */
export function redactSecrets(value, secrets = []) {
  if (typeof value !== "string" || value.length === 0) return value;
  const unique = [
    ...new Set(secrets.filter((secret) => typeof secret === "string" && secret)),
  ].sort((a, b) => b.length - a.length);
  let result = value;
  for (const secret of unique) {
    if (secret.length >= MIN_GLOBAL_SECRET_REDACTION_LENGTH) {
      result = result.split(secret).join("[REDACTED]");
      continue;
    }
    const standalone = new RegExp(
      `(^|[^A-Za-z0-9_.-])${escapeRegExp(secret)}(?=$|[^A-Za-z0-9_.-])`,
      "g",
    );
    result = result.replace(standalone, (_match, prefix) => `${prefix}[REDACTED]`);
  }
  return result;
}

function truncateContent(value, maxLength) {
  if (typeof value !== "string" || value.length <= maxLength) return value;
  const omitted = value.length - maxLength;
  const marker = `\n… [truncated ${omitted} chars]`;
  return `${value.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

/** Redact and bound arbitrary provider output before logging or persistence. */
export function sanitizeProviderText(value, secrets = [], maxLength = 50_000) {
  return truncateContent(redactSecrets(value, secrets), maxLength);
}

/** Redact and bound every normalized event before it can be persisted. */
export function sanitizeProviderEvent(event, secrets = []) {
  if (!event || typeof event !== "object") return event;
  const maxLength = EVENT_CONTENT_LIMITS[event.event_type] || 2_000;
  const content = sanitizeProviderText(event.content, secrets, maxLength);
  const toolName = sanitizeProviderText(event.tool_name, secrets, 200);
  return { ...event, content, ...(event.tool_name !== undefined ? { tool_name: toolName } : {}) };
}

// Cache resolved binary paths. A name resolves to its absolute path, or to
// null when it isn't on PATH — there is NO bare-name fallback, so
// detectCapabilities advertises only CLIs the runner can actually spawn (a
// runner that advertised a missing CLI would claim work it then can't run).
const binaryPathCache = {};

export function resolveBinary(name) {
  if (!(name in binaryPathCache)) {
    try {
      binaryPathCache[name] = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    } catch {
      binaryPathCache[name] = null; // not on PATH — do not advertise or spawn it
    }
  }
  return binaryPathCache[name];
}

/** Clear the resolved-binary cache. For tests that manipulate process.env.PATH. */
export function resetBinaryCache() {
  for (const key of Object.keys(binaryPathCache)) delete binaryPathCache[key];
}

// Normalized event types emitted by all providers:
//   text_delta   — streaming text content
//   tool_start   — agent started using a tool
//   tool_end     — tool execution finished (with output)
//   thinking     — model thinking/reasoning
//   info         — system info (init, model, etc.)
//   error        — error message
//   result       — final summary

// Extract a concise display string from a tool's input JSON.
function formatToolInput(toolName, inputJson) {
  if (!inputJson) return null;
  try {
    const input = typeof inputJson === "string" ? JSON.parse(inputJson) : inputJson;
    switch (String(toolName).toLowerCase()) {
      case "bash":
        return input.command || null;
      case "read":
      case "write":
      case "edit":
        return input.file_path || input.filePath || input.path || null;
      case "grep":
        return input.pattern || null;
      case "glob":
        return input.pattern || null;
      case "agent":
      case "task":
        return input.description || null;
      case "websearch":
        return input.query || null;
      case "webfetch":
        return input.url || null;
      default: {
        const str = JSON.stringify(input);
        return str.length > 200 ? `${str.slice(0, 200)}...` : str;
      }
    }
  } catch {
    return null;
  }
}

// A usage field is only ever a finite number — anything else counts as 0 so
// token sums can never go NaN on a malformed or partial terminal event.
function usageNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize a CLI's terminal usage payload into the one cross-provider shape
 * the server accumulates: `{ input_tokens, output_tokens }`, where
 * input_tokens counts ALL input-side tokens (fresh + cache reads + cache
 * creation). Both parsers route through here so the server never branches on
 * CLI.
 *
 * claude `result` events carry `modelUsage` (per-model breakdown including
 * background models the top-level `usage` misses) — preferred — with additive
 * camelCase cache fields; the top-level `usage` fallback has the same additive
 * cache fields in snake_case. codex `turn.completed` carries only `usage`,
 * whose `cached_input_tokens` is a SUBSET of `input_tokens` (never added — it
 * matches none of the summed keys). Returns null when the object carries no
 * usage at all, so callers can omit the field entirely.
 */
export function normalizeUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const models =
    obj.modelUsage && typeof obj.modelUsage === "object" ? Object.values(obj.modelUsage) : [];
  if (models.length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      inputTokens +=
        usageNum(model.inputTokens) +
        usageNum(model.cacheReadInputTokens) +
        usageNum(model.cacheCreationInputTokens);
      outputTokens += usageNum(model.outputTokens);
    }
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens:
      usageNum(usage.input_tokens) +
      usageNum(usage.cache_read_input_tokens) +
      usageNum(usage.cache_creation_input_tokens),
    output_tokens: usageNum(usage.output_tokens),
  };
}

/**
 * Guard: every buildCommand needs a policy resolved by resolveAgentPolicy
 * (bin/lib/policy.mjs) — the runner does that before spawning. Throwing on a
 * missing or failed policy is deliberate: the alternative to a resolved policy
 * is not "run with defaults", it's "run the agent unrestricted", and that must
 * never be reachable by forgetting an argument.
 */
function requirePolicy(policy, cli) {
  if (!policy?.ok) {
    throw new Error(
      `Cannot build a ${cli} command without a resolved permission policy (got ${policy?.reason ? `invalid policy: ${policy.reason}` : JSON.stringify(policy)}).`,
    );
  }
}

/**
 * Codex argv for the resolved policy.
 *
 * `--skip-git-repo-check` is required in enforced mode: agent workspaces aren't
 * usually git repos, and without the flag Codex refuses to start ("Not inside a
 * trusted directory and --skip-git-repo-check was not specified"). The bypass
 * flag implied it, which is why unrestricted mode never needed it.
 *
 * `-s <mode>` is passed explicitly from the policy file rather than left to
 * Codex's project-config resolution, so the effective sandbox is deterministic
 * and visible in the argv (and asserted in tests) instead of depending on
 * whether the workspace's `.codex` layer was trusted.
 */
function codexPolicyArgs(policy) {
  if (policy.mode === "unrestricted") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["--skip-git-repo-check", "-s", policy.sandboxMode, "-c", "approval_policy=never"];
}

// Provider: how to invoke each CLI tool in batch mode, with streaming support

const PROVIDERS = {
  claude: {
    // Resume capability: the finalize turn (issue #34) resumes the same CLI
    // session via buildCommand(sessionId, isNewSession=false). All shipped
    // providers support it; the flag lets the runner pick resume vs a fresh
    // finalize turn generically without provider-specific branching.
    canResume: true,
    // Levels the CLI's --effort flag accepts. Mirrors CLI_CONFIG in
    // src/lib/cli-config.ts (two bundles, so duplicated by necessity);
    // providers.test.ts locks the two together.
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    generateSessionId() {
      return crypto.randomUUID();
    },
    buildCommand(prompt, model, workingDir, sessionId, isNewSession, thinking, policy) {
      requirePolicy(policy, "claude");
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];
      if (policy.mode === "unrestricted") {
        // The agent is explicitly set to Unrestricted in the dashboard.
        args.push("--dangerously-skip-permissions");
      } else {
        // Enforced: hand the CLI the operator's own settings file. Passed with
        // --settings rather than left to cwd discovery because several sandbox
        // keys (strictAllowlist, credential masking, filesystem.disabled) are
        // ignored from project-scope settings and honored only from
        // user/managed/--settings — discovery would silently drop exactly the
        // keys that do the containing. --setting-sources pins the rest to the
        // workspace so the runner host's own ~/.claude/settings.json can't
        // loosen (or break) an agent.
        args.push("--settings", policy.settingsPath);
        args.push("--permission-mode", policy.permissionMode);
        args.push("--setting-sources", "project");
      }
      if (model) args.push("--model", model);
      if (thinking) args.push("--effort", thinking);
      if (isNewSession && sessionId) {
        args.push("--session-id", sessionId);
      } else if (sessionId) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { binary: resolveBinary("claude"), args, cwd: workingDir };
    },
    // Returns a stateful parser that accumulates tool input from streaming
    // deltas before emitting tool_start with the full input content.
    createParser() {
      // Track in-flight tool_use blocks: index → { toolName, inputJson }
      const activeBlocks = new Map();
      // The Anthropic stream protocol emits no separator between distinct text
      // content blocks (common when text is interleaved with tool_use). Naive
      // concatenation produces "first sentence.second sentence." — inject a
      // paragraph break at the start of each new text block after the first.
      let hasEmittedText = false;
      let needsLeadingBreak = false;

      return {
        parseLine(line) {
          try {
            const obj = JSON.parse(line);
            const events = [];

            if (obj.type === "system" && obj.subtype === "init") {
              events.push({ event_type: "info", content: `Model: ${obj.model}` });
              return { events, sessionId: obj.session_id };
            }

            if (obj.type === "stream_event" && obj.event) {
              const evt = obj.event;
              if (evt.type === "content_block_delta") {
                if (evt.delta?.type === "text_delta" && evt.delta.text) {
                  let text = evt.delta.text;
                  if (needsLeadingBreak) {
                    text = `\n\n${text}`;
                    needsLeadingBreak = false;
                  }
                  events.push({ event_type: "text_delta", content: text });
                  hasEmittedText = true;
                }
                if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
                  events.push({ event_type: "thinking", content: evt.delta.thinking });
                }
                // Accumulate tool input JSON fragments
                if (evt.delta?.type === "input_json_delta" && evt.delta.partial_json != null) {
                  const block = activeBlocks.get(evt.index);
                  if (block) block.inputJson += evt.delta.partial_json;
                }
              }
              // Register tool block — defer tool_start until input is assembled
              if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                activeBlocks.set(evt.index, {
                  toolName: evt.content_block.name,
                  inputJson: "",
                });
              }
              // New text block after we've already emitted text → mark a paragraph break
              if (evt.type === "content_block_start" && evt.content_block?.type === "text") {
                if (hasEmittedText) needsLeadingBreak = true;
              }
              // Input fully assembled — emit tool_start with content
              if (evt.type === "content_block_stop") {
                const block = activeBlocks.get(evt.index);
                if (block) {
                  activeBlocks.delete(evt.index);
                  events.push({
                    event_type: "tool_start",
                    content: formatToolInput(block.toolName, block.inputJson),
                    tool_name: block.toolName,
                  });
                }
              }
            }

            // Tool result comes as an assistant message with tool_result content
            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "tool_result") {
                  events.push({
                    event_type: "tool_end",
                    content:
                      typeof block.content === "string"
                        ? block.content
                        : JSON.stringify(block.content),
                    tool_name: null,
                  });
                }
              }
            }

            if (obj.type === "result") {
              events.push({
                event_type: "result",
                content: obj.result || null,
              });
              // The result event is the only place claude reports token usage —
              // surface it beside sessionId (omitted when the event has none).
              const usage = normalizeUsage(obj);
              return { events, sessionId: obj.session_id, ...(usage ? { usage } : {}) };
            }

            return { events };
          } catch {
            return { events: [] };
          }
        },
      };
    },
    parseResult(stdout, presetSessionId) {
      // Fallback full-parse for final content extraction
      const lines = stdout.trim().split("\n");
      let content = "";
      let sessionId = presetSessionId;
      let usage = null;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "result") {
            if (obj.result) content = obj.result;
            // Loss-proof usage fallback: the streaming path can miss the
            // result line (flush-on-close partial line); this rescan sees it.
            const resultUsage = normalizeUsage(obj);
            if (resultUsage) usage = resultUsage;
          }
          if (obj.session_id) sessionId = obj.session_id;
        } catch {
          /* skip */
        }
      }
      if (!content) content = stdout;
      return { content: content.trim(), sessionId, ...(usage ? { usage } : {}) };
    },
  },

  codex: {
    canResume: true,
    // Levels model_reasoning_effort accepts — kept in sync with CLI_CONFIG
    // (see claude.thinkingLevels above).
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    buildCommand(prompt, model, workingDir, sessionId, _isNewSession, thinking, policy) {
      requirePolicy(policy, "codex");
      // Codex 0.128+ removed the top-level --reasoning-effort flag. Use the
      // generic config override instead: -c model_reasoning_effort=<level>.
      const args = sessionId ? ["exec", "resume"] : ["exec"];
      args.push(...codexPolicyArgs(policy), "--json");
      if (model) args.push("-m", model);
      if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
      if (sessionId) args.push(sessionId);
      args.push(prompt);
      return { binary: resolveBinary("codex"), args, cwd: workingDir };
    },
    // Codex emits each agent_message as a complete, distinct message (narration
    // before tool calls, then a final summary) — unlike claude's token deltas.
    // Joining them with "" runs sentences together; this stateful wrapper
    // inserts a paragraph break before every message after the first.
    createParser() {
      let hasEmittedText = false;
      const base = this;
      return {
        parseLine(line) {
          const parsed = base.parseLine(line);
          for (const evt of parsed.events || []) {
            if (evt.event_type === "text_delta" && evt.content) {
              if (hasEmittedText) evt.content = `\n\n${evt.content}`;
              hasEmittedText = true;
            }
          }
          return parsed;
        },
      };
    },
    parseLine(line) {
      try {
        const obj = JSON.parse(line);
        const events = [];

        if (obj.type === "thread.started" && obj.thread_id) {
          events.push({ event_type: "info", content: `Thread: ${obj.thread_id}` });
          return { events, sessionId: obj.thread_id };
        }

        if (obj.type === "item.started" && obj.item) {
          if (obj.item.type === "command_execution") {
            events.push({
              event_type: "tool_start",
              content: obj.item.command || null,
              tool_name: "shell",
            });
          }
        }

        if (obj.type === "item.completed" && obj.item) {
          if (obj.item.type === "agent_message" && obj.item.text) {
            events.push({ event_type: "text_delta", content: obj.item.text });
          }
          if (obj.item.type === "command_execution") {
            events.push({
              event_type: "tool_end",
              content:
                obj.item.aggregated_output != null && obj.item.aggregated_output !== ""
                  ? obj.item.aggregated_output
                  : `exit ${obj.item.exit_code}`,
              tool_name: "shell",
            });
          }
        }

        if (obj.type === "turn.completed") {
          events.push({
            event_type: "result",
            content: obj.usage
              ? `Tokens: ${obj.usage.input_tokens} in / ${obj.usage.output_tokens} out`
              : null,
          });
          // turn.completed is the only place codex reports token usage —
          // surface the normalized shape (omitted when the event has none).
          const usage = normalizeUsage(obj);
          return { events, ...(usage ? { usage } : {}) };
        }

        return { events };
      } catch {
        return { events: [] };
      }
    },
    // Only use the last assistant message as the activity summary. Codex emits
    // multiple agent_message items during a run (narration before each tool call,
    // then a final summary). Concatenating all of them produces a verbose dump;
    // the last message is the natural summary of what was done.
    parseResult(stdout) {
      const lines = stdout.trim().split("\n");
      let sessionId = null;
      let lastMessage = "";
      let usage = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "thread.started" && obj.thread_id) {
            sessionId = obj.thread_id;
          }
          // Loss-proof usage fallback (see claude.parseResult): the last
          // turn.completed carries the turn's totals.
          if (obj.type === "turn.completed") {
            const turnUsage = normalizeUsage(obj);
            if (turnUsage) usage = turnUsage;
          }
          if (obj.type === "item.completed" && obj.item) {
            if (obj.item.text) {
              lastMessage = obj.item.text;
            } else if (obj.item.content) {
              let text = "";
              for (const c of obj.item.content) {
                if (c.type === "output_text" || c.type === "text") {
                  text += `${c.text || ""}\n`;
                }
              }
              if (text.trim()) lastMessage = text.trim();
            }
          }
          if (obj.type === "message.completed" && obj.message) {
            if (obj.message.text) {
              lastMessage = obj.message.text;
            } else if (obj.message.content) {
              let text = "";
              for (const c of obj.message.content) {
                if (c.type === "output_text" || c.type === "text") {
                  text += `${c.text || ""}\n`;
                }
              }
              if (text.trim()) lastMessage = text.trim();
            }
          }
        } catch {
          /* Not JSON line */
        }
      }

      if (!lastMessage.trim()) lastMessage = stdout;
      return { content: lastMessage.trim(), sessionId, ...(usage ? { usage } : {}) };
    },
  },
};

export function getProvider(cli) {
  const provider = PROVIDERS[cli];
  if (!provider) throw new Error(`Unknown CLI provider: ${cli}`);
  return provider;
}

/** The CLI providers this runtime knows how to drive. */
export const KNOWN_CLIS = Object.keys(PROVIDERS);

/**
 * Detect what this host can execute, advertised on every claim (Runner Protocol).
 *   clis   — installed CLIs (claude/codex) found on PATH.
 *   kinds  — always "workflow" (shell gates need only bash/python/node); plus
 *            "agent" when at least one CLI is present.
 *   labels — placement labels this runner serves; default ["local"], overridable
 *            via HARBOUR_RUNNER_LABELS (comma-separated) for a remote runner.
 */
export function detectCapabilities() {
  const clis = KNOWN_CLIS.filter((cli) => !!resolveBinary(cli));
  const kinds = clis.length > 0 ? ["agent", "workflow"] : ["workflow"];
  const labels = (process.env.HARBOUR_RUNNER_LABELS || "local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { kinds, clis, labels: labels.length > 0 ? labels : ["local"] };
}

/**
 * Guard the resolved thinking level against the provider's accepted list
 * (issue #39: `--effort off` failed every run at CLI launch). A level the
 * CLI won't accept — written before API validation existed, or stranded by
 * CLI version drift — is dropped so the run proceeds on the CLI default.
 *
 * Returns { thinking, dropped }: `dropped` carries the discarded value when
 * it's worth warning about, i.e. only for known CLIs that take a level.
 */
export function sanitizeThinking(cli, thinking) {
  if (!thinking) return { thinking: null, dropped: null };
  const levels = PROVIDERS[cli]?.thinkingLevels || [];
  if (levels.includes(thinking)) return { thinking, dropped: null };
  return { thinking: null, dropped: levels.length > 0 ? thinking : null };
}

/**
 * Resolve which cli/model/thinking a run should use. Harbour is the source of
 * truth: the claim payload's agent block carries the agent's live config and is
 * authoritative — including its nulls, so a model you cleared in the dashboard
 * stays cleared. A per-job override always wins.
 *
 * Precedence: job override → agent block.
 *
 * `permissions` is the one field with no job-level override and no null: it
 * normalizes fail-closed, so an older server that sends no value (or any junk)
 * yields 'enforced' rather than an unrestricted agent. There is no per-job
 * permission override by design — permissions belong to the agent, so one job
 * can't quietly widen what an agent may do.
 */
export function resolveRunConfig(payload) {
  const job = payload?.job || {};
  const agent = payload?.agent ?? {};
  return {
    cli: agent.cli ?? null,
    model: job.model || agent.model || null,
    thinking: job.thinking || agent.thinking || null,
    permissions: agent.permissions === "unrestricted" ? "unrestricted" : "enforced",
  };
}

// What a single workspace path segment must look like. Exported so tests can
// lock this against the server's slugify — every slug the server assigns must
// pass this regex, or the runner will refuse the run.
export const WORKSPACE_SEGMENT_RE = /^[a-z0-9-]+$/;

/**
 * Resolve (and create) a workspace directory from pre-slugged path segments:
 * ensureWorkingDir(["website", "dev-agent"]) →
 * ~/.harbour/workspaces/website/dev-agent.
 *
 * Segments are validated, never transformed: re-slugifying runner-side could
 * map two distinct server slugs onto one directory, silently reintroducing
 * the same-name workspace collision the nested layout exists to eliminate.
 * A segment that fails WORKSPACE_SEGMENT_RE is a hard error.
 */
export function ensureWorkingDir(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("No workspace path segments provided");
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || !WORKSPACE_SEGMENT_RE.test(segment)) {
      throw new Error(`Invalid workspace path segment: ${JSON.stringify(segment)}`);
    }
  }
  const home = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
  const dir = path.join(home, "workspaces", ...segments);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Build the child environment for a CLI run: host env plus the job's own. */
export function buildChildEnvironment({ extraEnv = {} } = {}) {
  const env = { ...process.env, ...(extraEnv || {}) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION;
  delete env.CLAUDE_CODE_PARENT_SESSION;
  return env;
}

/**
 * Run a CLI tool, streaming JSONL output line-by-line to onLine callback.
 * Returns { code, stdout, stderr, aborted, timedOut } when the process exits.
 *
 * Liveness is governed by a single INACTIVITY timer (issue #15): it is armed at
 * spawn and reset on every chunk of output. If the process produces nothing for
 * `inactivityTimeoutMs` (default 3 min) it is SIGTERM'd, then SIGKILL'd after
 * `killGraceMs`, and `timedOut` is set. This catches both startup hangs (auth
 * prompts, login waits) and mid-run stalls (a blocked API call that never
 * returns), while a productive agent streaming JSON resets the timer
 * continuously and is never killed at an arbitrary wallclock cap. The job's
 * `timeout_minutes` is enforced separately, server-side, as a hard ceiling.
 *
 * Pass `signal` (an AbortSignal) to request a graceful kill: SIGTERM is sent
 * immediately, followed by SIGKILL after `killGraceMs` (default 3s) if the
 * process hasn't exited.
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ inactivityTimeoutMs?: number, killGraceMs?: number, onLine?: (line: string) => void, signal?: AbortSignal, extraEnv?: Record<string, string> }} [opts]
 */
export function runCliTool(
  binary,
  args,
  cwd,
  { inactivityTimeoutMs = 3 * 60 * 1000, killGraceMs = 3000, onLine, signal, extraEnv } = {},
) {
  return new Promise((resolve, reject) => {
    // Build clean environment: strip Claude Code nesting guards, then layer
    // run-scoped env vars (decrypted Harbour env vars for this job) on top.
    // Putting them in the actual process env (not just the prompt) lets the
    // agent's shell expand `$VARNAME` naturally — needed for `curl -H
    // "Authorization: Bearer $TOKEN"` and similar patterns.
    const env = buildChildEnvironment({ extraEnv });
    // If the workspace has a `bin/` directory, prepend it to PATH so per-agent
    // wrapper scripts (e.g. auth-curl shims) resolve as bare command names.
    try {
      const workspaceBin = path.join(cwd, "bin");
      if (fs.statSync(workspaceBin).isDirectory()) {
        env.PATH = `${workspaceBin}:${env.PATH || ""}`;
      }
    } catch {
      /* no workspace bin/, ignore */
    }

    const child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // Close stdin immediately — CLI tools should not wait for interactive input
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let aborted = false;
    let timedOut = false;
    let killFollowupTimer = null;
    let closeFired = false;
    let postExitTimer = null;
    // If the CLI spawns grandchildren that inherit our stdout/stderr pipes
    // (docker compose, dev servers, simulators), "close" won't fire until
    // those descendants release the fds — which can be never. After the
    // process itself exits, give pipes a brief grace to drain, then
    // destroy them so the wrapper can resolve.
    const POST_EXIT_GRACE_MS = 2000;

    // Single inactivity timer (issue #15): armed at spawn, reset on every chunk
    // of output. Replaces the old 30s startup timer + fixed wallclock spawn
    // timeout. If the process is silent for inactivityTimeoutMs we SIGTERM it,
    // then SIGKILL after killGraceMs in case it traps the signal. Silence at
    // startup (auth prompt / login hang) and silence mid-run (a stalled API
    // call) are the same failure mode — no output — so one timer covers both.
    let inactivityTimer = null;
    function armInactivity() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, killGraceMs);
      }, inactivityTimeoutMs);
    }
    armInactivity();

    // Abort handler: SIGTERM → killGraceMs grace → SIGKILL
    function handleAbort() {
      if (aborted) return;
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      killFollowupTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, killGraceMs);
    }
    if (signal) {
      if (signal.aborted) handleAbort();
      else signal.addEventListener("abort", handleAbort, { once: true });
    }

    child.stdout.on("data", (data) => {
      armInactivity(); // any output proves the process is alive — reset the clock
      const chunk = data.toString();
      stdout += chunk;

      if (onLine) {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
    });

    child.stderr.on("data", (data) => {
      armInactivity();
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (killFollowupTimer) clearTimeout(killFollowupTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
      if (err && err.code === "ENOENT") {
        // The binary vanished between capability detection and spawn (or PATH
        // differs). Point at the usual cause: a launchd/systemd service has its
        // own fixed PATH, not the interactive shell's.
        reject(
          new Error(
            `"${binary}" was not found on the runner's PATH — install it or add its directory to the service PATH (a service does not inherit your shell PATH).`,
          ),
        );
        return;
      }
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
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (killFollowupTimer) clearTimeout(killFollowupTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
      // Flush remaining buffer
      if (onLine && lineBuffer.trim()) {
        onLine(lineBuffer.trim());
      }
      resolve({ code, stdout, stderr, aborted, timedOut });
    });
  });
}
