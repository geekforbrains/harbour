import { execFileSync, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENCODE_API_KEY_ENV = "HARBOUR_OPENCODE_API_KEY";
const MIN_OPENCODE_VERSION = [1, 17, 12];
const MIN_GLOBAL_SECRET_REDACTION_LENGTH = 4;
const OPENCODE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const OPENCODE_VARIANT_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const ISOLATED_HOST_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  // Preserve the host's normal data/config locations. OpenCode session data
  // must remain stable across runs, and shell tools launched by the agent may
  // keep their own credentials under these paths. Harbour never overrides
  // them; inline OpenCode config/auth controls isolate the model provider.
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const RESERVED_OPENCODE_ENV = new Set([
  OPENCODE_API_KEY_ENV,
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

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

function normalizedBaseUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OpenCode provider base_url must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenCode provider base_url must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OpenCode provider base_url must not contain credentials");
  }
  if (parsed.search) {
    throw new Error("OpenCode provider base_url must not contain a query string");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function splitOpenCodeModel(model) {
  if (typeof model !== "string" || model.includes("\n") || model.includes("\r")) {
    throw new Error("OpenCode requires a model in provider/model form");
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error("OpenCode requires a model in provider/model form");
  }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * Build the complete, Harbour-owned OpenCode runtime config. Only typed claim
 * metadata is accepted: callers cannot inject npm packages or raw OpenCode
 * configuration. The returned fingerprint contains no credential material.
 */
export function buildOpenCodeRuntime({
  model,
  variant,
  provider,
  apiKey,
  harbourHome = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour"),
}) {
  if (!provider || typeof provider !== "object") {
    throw new Error("OpenCode requires a configured LLM provider connection");
  }

  const presetKinds = new Set(["openai", "anthropic", "openrouter"]);
  const allowedKinds = new Set([...presetKinds, "ollama", "openai-compatible"]);
  const kind = provider.kind;
  if (!allowedKinds.has(kind)) throw new Error(`Unsupported OpenCode provider kind: ${kind}`);
  if (apiKey != null && typeof apiKey !== "string") {
    throw new Error("OpenCode provider API key must be a string");
  }

  const presetProviderId = presetKinds.has(kind) || kind === "ollama" ? kind : null;
  const providerId = provider.provider_id || presetProviderId;
  if (typeof providerId !== "string" || !OPENCODE_PROVIDER_ID_RE.test(providerId)) {
    throw new Error(
      "OpenCode provider_id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (presetProviderId && providerId !== presetProviderId) {
    throw new Error(`OpenCode ${kind} connections must use provider_id "${presetProviderId}"`);
  }

  const protocol = provider.protocol;
  if (presetKinds.has(kind) && protocol !== "native") {
    throw new Error(`OpenCode ${kind} connections must use protocol "native"`);
  }
  if (kind === "ollama" && protocol !== "chat-completions") {
    throw new Error('OpenCode Ollama connections must use protocol "chat-completions"');
  }
  if (kind === "openai-compatible" && protocol !== "chat-completions" && protocol !== "responses") {
    throw new Error(
      'OpenCode compatible connections must use protocol "chat-completions" or "responses"',
    );
  }

  const splitModel = splitOpenCodeModel(model);
  if (splitModel.providerId !== providerId) {
    throw new Error(`OpenCode model "${model}" must use provider "${providerId}"`);
  }
  if (variant != null && (typeof variant !== "string" || !OPENCODE_VARIANT_RE.test(variant))) {
    throw new Error("OpenCode variant contains unsupported characters");
  }
  if (presetKinds.has(kind) && !apiKey) {
    throw new Error(`OpenCode ${kind} connections require an API key`);
  }

  const baseURL =
    kind === "ollama"
      ? normalizedBaseUrl(provider.base_url || "http://127.0.0.1:11434/v1")
      : normalizedBaseUrl(provider.base_url);
  if (kind === "openai-compatible" && !baseURL) {
    throw new Error("OpenCode compatible connections require a base_url");
  }

  const options = {};
  if (baseURL) options.baseURL = baseURL;
  if (apiKey) options.apiKey = `{env:${OPENCODE_API_KEY_ENV}}`;

  const providerConfig = { options };
  if (kind === "ollama" || kind === "openai-compatible") {
    providerConfig.npm = protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
    providerConfig.models = { [splitModel.modelId]: { name: splitModel.modelId } };
  }

  const config = {
    enabled_providers: [providerId],
    share: "disabled",
    autoupdate: false,
    permission: {
      external_directory: "deny",
      question: "deny",
    },
    provider: { [providerId]: providerConfig },
  };

  const nonSecretConfig = {
    version: 1,
    connectionId: provider.id || null,
    credentialId: provider.credential_id || null,
    kind,
    providerId,
    baseURL,
    protocol,
    model,
    variant: variant || null,
  };
  const configFingerprint = `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(nonSecretConfig))
    .digest("hex")}`;

  const root = path.join(harbourHome, "opencode");
  /** @type {Record<string, string>} */
  const controlEnv = {
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    // Repositories are work input, not provider configuration. Without this,
    // a checked-in opencode.json/.opencode directory can retain deep-merged
    // provider fields (including baseURL), MCP servers, or executable plugins.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_SERVER_PASSWORD: crypto.randomBytes(32).toString("base64url"),
    OPENCODE_CLIENT: "harbour",
  };
  if (apiKey) controlEnv[OPENCODE_API_KEY_ENV] = apiKey;

  return {
    configFingerprint,
    controlEnv,
    isolatedEnv: true,
    launchDir: path.join(root, "runtime"),
    secretValues: [apiKey, controlEnv.OPENCODE_SERVER_PASSWORD].filter(Boolean),
  };
}

// Cache resolved binary paths. A name resolves to its absolute path, or to
// null when it isn't on PATH — there is NO bare-name fallback, so
// detectCapabilities advertises only CLIs the runner can actually spawn (a
// runner that advertised a missing CLI would claim work it then can't run).
const binaryPathCache = {};
const binaryVersionCache = {};

/** 1.17.12 is the first release with every unattended-run flag Harbour uses. */
export function isOpenCodeVersionSupported(value) {
  const match = String(value || "").match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_OPENCODE_VERSION.length; index++) {
    if (actual[index] > MIN_OPENCODE_VERSION[index]) return true;
    if (actual[index] < MIN_OPENCODE_VERSION[index]) return false;
  }
  return true;
}

function hasSupportedOpenCodeVersion(binary) {
  if (!(binary in binaryVersionCache)) {
    try {
      const output = execFileSync(binary, ["--version"], { encoding: "utf-8" }).trim();
      binaryVersionCache[binary] = isOpenCodeVersionSupported(output);
    } catch {
      binaryVersionCache[binary] = false;
    }
  }
  return binaryVersionCache[binary];
}

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
  for (const key of Object.keys(binaryVersionCache)) delete binaryVersionCache[key];
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
    buildCommand(prompt, model, workingDir, sessionId, isNewSession, thinking) {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];
      // If the workspace has a valid .claude/settings.json with a permissions
      // object, opt into the permission system. Otherwise, fall back to the
      // legacy unrestricted mode so existing agents keep working without
      // per-agent config.
      //
      // Validate by stat (regular file, not a symlink to /dev/null) and JSON
      // parse with a permissions object — a corrupt or empty settings file
      // shouldn't silently switch the agent into a less-protected mode.
      let hasSettings = false;
      try {
        const settingsPath = path.join(workingDir, ".claude", "settings.json");
        const st = fs.statSync(settingsPath);
        if (st.isFile() && st.size > 0) {
          const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
          if (parsed && typeof parsed.permissions === "object") {
            hasSettings = true;
          }
        }
      } catch {
        // Missing file, parse error, etc. — fall through to legacy mode.
      }
      if (!hasSettings) {
        args.push("--dangerously-skip-permissions");
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
              return { events, sessionId: obj.session_id };
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
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "result" && obj.result) {
            content = obj.result;
          }
          if (obj.session_id) sessionId = obj.session_id;
        } catch {
          /* skip */
        }
      }
      if (!content) content = stdout;
      return { content: content.trim(), sessionId };
    },
  },

  codex: {
    canResume: true,
    // Levels model_reasoning_effort accepts — kept in sync with CLI_CONFIG
    // (see claude.thinkingLevels above).
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    buildCommand(prompt, model, workingDir, sessionId, _isNewSession, thinking) {
      // Codex 0.128+ removed the top-level --reasoning-effort flag. Use the
      // generic config override instead: -c model_reasoning_effort=<level>.
      if (sessionId) {
        const args = ["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "--json"];
        if (model) args.push("-m", model);
        if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
        args.push(sessionId, prompt);
        return { binary: resolveBinary("codex"), args, cwd: workingDir };
      }
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"];
      if (model) args.push("-m", model);
      if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
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

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "thread.started" && obj.thread_id) {
            sessionId = obj.thread_id;
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
      return { content: lastMessage.trim(), sessionId };
    },
  },

  opencode: {
    canResume: true,
    acceptsArbitraryThinking: true,
    requiresConfigFingerprint: true,
    // Suggestions shown in the dashboard. Unlike Claude/Codex this is not an
    // allowlist: OpenCode accepts any validated variant token.
    thinkingLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    buildCommand(prompt, model, workingDir, sessionId, _isNewSession, variant, runtime) {
      if (!runtime?.launchDir) throw new Error("OpenCode runtime configuration is missing");
      // Keep OpenCode's Bun bootstrap out of the workspace so it cannot
      // implicitly load a project .env before Harbour's isolated environment
      // and inline config are applied. --dir remains the actual agent workspace.
      const args = [
        "run",
        "--pure",
        "--auto",
        "--format",
        "json",
        "--model",
        model,
        "--dir",
        workingDir,
      ];
      if (sessionId) args.push("--session", sessionId);
      if (variant) args.push("--variant", variant);
      args.push(prompt);
      return {
        binary: resolveBinary("opencode"),
        args,
        cwd: runtime.launchDir,
        workspaceDir: workingDir,
      };
    },
    createParser() {
      const activeTools = new Set();
      let hasEmittedText = false;
      return {
        parseLine(line) {
          try {
            const obj = JSON.parse(line);
            const events = [];
            const sessionId = obj.sessionID || obj.session_id || undefined;
            const part = obj.part && typeof obj.part === "object" ? obj.part : {};

            if (obj.type === "text" && typeof part.text === "string" && part.text) {
              const content = hasEmittedText ? `\n\n${part.text}` : part.text;
              hasEmittedText = true;
              events.push({ event_type: "text_delta", content });
            }

            if (obj.type === "reasoning" && typeof part.text === "string" && part.text) {
              events.push({ event_type: "thinking", content: part.text });
            }

            if (obj.type === "tool_use") {
              const state = part.state && typeof part.state === "object" ? part.state : {};
              const toolName = typeof part.tool === "string" ? part.tool : "tool";
              const callId = String(
                part.id || part.callID || part.call_id || `${toolName}:unknown`,
              );
              const status = state.status;
              const terminal = status === "completed" || status === "error" || status === "failed";

              if (!activeTools.has(callId)) {
                activeTools.add(callId);
                events.push({
                  event_type: "tool_start",
                  content: formatToolInput(toolName, state.input),
                  tool_name: toolName,
                });
              }

              if (terminal) {
                activeTools.delete(callId);
                let output = state.output;
                if (output == null || output === "") output = state.error || status;
                if (typeof output !== "string") output = JSON.stringify(output);
                events.push({ event_type: "tool_end", content: output, tool_name: toolName });
              }
            }

            if (obj.type === "step_finish") {
              const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : {};
              const usage = [];
              if (Number.isFinite(tokens.input)) usage.push(`${tokens.input} in`);
              if (Number.isFinite(tokens.output)) usage.push(`${tokens.output} out`);
              if (Number.isFinite(tokens.reasoning)) usage.push(`${tokens.reasoning} reasoning`);
              let content = usage.length ? `Tokens: ${usage.join(" / ")}` : "Step finished";
              if (Number.isFinite(part.cost))
                content += ` · Cost: $${Number(part.cost).toFixed(6)}`;
              events.push({ event_type: "result", content });
            }

            if (obj.type === "error") {
              const error = obj.error && typeof obj.error === "object" ? obj.error : {};
              const data = error.data && typeof error.data === "object" ? error.data : {};
              // Deliberate allowlist: responseBody/responseHeaders can contain
              // upstream credentials and must never be serialized wholesale.
              const name = typeof error.name === "string" ? error.name : "OpenCode error";
              const message =
                typeof data.message === "string"
                  ? data.message
                  : typeof error.message === "string"
                    ? error.message
                    : "Provider request failed";
              const details = [];
              if (typeof data.statusCode === "number") details.push(`status ${data.statusCode}`);
              if (typeof data.providerID === "string") details.push(`provider ${data.providerID}`);
              if (typeof data.modelID === "string") details.push(`model ${data.modelID}`);
              events.push({
                event_type: "error",
                content: `${name}: ${message}${details.length ? ` (${details.join(", ")})` : ""}`,
              });
            }

            return { events, ...(sessionId ? { sessionId } : {}) };
          } catch {
            return { events: [] };
          }
        },
      };
    },
    parseResult(stdout, presetSessionId) {
      let sessionId = presetSessionId || null;
      let lastText = "";
      let lastError = "";
      for (const line of stdout.trim().split("\n")) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionID || obj.session_id) sessionId = obj.sessionID || obj.session_id;
          if (obj.type === "text" && typeof obj.part?.text === "string" && obj.part.text.trim()) {
            lastText = obj.part.text;
          }
          if (obj.type === "error") {
            const parsed = this.createParser().parseLine(line);
            const event = parsed.events.find((item) => item.event_type === "error");
            if (event?.content) lastError = event.content;
          }
        } catch {
          /* skip non-JSON output */
        }
      }
      return { content: (lastText || lastError || stdout).trim(), sessionId };
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
  const clis = KNOWN_CLIS.filter((cli) => {
    const binary = resolveBinary(cli);
    if (!binary) return false;
    return cli !== "opencode" || hasSupportedOpenCodeVersion(binary);
  });
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
  if (PROVIDERS[cli]?.acceptsArbitraryThinking) {
    return OPENCODE_VARIANT_RE.test(thinking)
      ? { thinking, dropped: null }
      : { thinking: null, dropped: thinking };
  }
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
 */
export function resolveRunConfig(payload) {
  const job = payload?.job || {};
  const agent = payload?.agent ?? {};
  return {
    cli: agent.cli ?? null,
    model: job.model || agent.model || null,
    thinking: job.thinking || agent.thinking || null,
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

/** Build a child environment with optional host isolation and final controls. */
export function buildChildEnvironment({
  extraEnv = {},
  controlEnv = {},
  isolatedEnv = false,
} = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (!isolatedEnv || ISOLATED_HOST_ENV_KEYS.has(key) || key.startsWith("LC_"))
    ) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (
      isolatedEnv &&
      (RESERVED_OPENCODE_ENV.has(key) || key.startsWith("OPENCODE_") || key.startsWith("XDG_"))
    ) {
      continue;
    }
    env[key] = value;
  }
  // Runner controls always win over job-defined environment variables.
  Object.assign(env, controlEnv || {});

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
 * @param {{ inactivityTimeoutMs?: number, killGraceMs?: number, onLine?: (line: string) => void, signal?: AbortSignal, extraEnv?: Record<string, string>, controlEnv?: Record<string, string>, isolatedEnv?: boolean, workspaceDir?: string }} [opts]
 */
export function runCliTool(
  binary,
  args,
  cwd,
  {
    inactivityTimeoutMs = 3 * 60 * 1000,
    killGraceMs = 3000,
    onLine,
    signal,
    extraEnv,
    controlEnv,
    isolatedEnv = false,
    workspaceDir,
  } = {},
) {
  return new Promise((resolve, reject) => {
    // Build clean environment: strip Claude Code nesting guards, then layer
    // run-scoped env vars (decrypted Harbour env vars for this job) on top.
    // Putting them in the actual process env (not just the prompt) lets the
    // agent's shell expand `$VARNAME` naturally — needed for `curl -H
    // "Authorization: Bearer $TOKEN"` and similar patterns.
    const env = buildChildEnvironment({ extraEnv, controlEnv, isolatedEnv });
    // If the workspace has a `bin/` directory, prepend it to PATH so per-agent
    // wrapper scripts (e.g. auth-curl shims) resolve as bare command names.
    try {
      const workspaceBin = path.join(workspaceDir || cwd, "bin");
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
