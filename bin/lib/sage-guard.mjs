import { createRequire } from "module";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);
let sageCorePromise = null;

async function getSageCore() {
  if (!globalThis.require) {
    globalThis.require = require;
  }
  if (!sageCorePromise) sageCorePromise = import("@gendigital/sage-core");
  return sageCorePromise;
}

const BORG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HARBOUR_ROOT = resolve(BORG_ROOT, "harbour");
const SAGE_OPENCLAW_ROOT = dirname(require.resolve("@gendigital/sage-openclaw/package.json"));

export const SAGE_RUNTIME_SECURITY = Object.freeze({
  provider: "sage",
  source_repo: "https://github.com/gendigitalinc/sage.git",
  version: "0.9.0",
  enforcement: "hard-gate",
  required_for: ["openclaw", "hermes", "workflow", "future-agent-cli"],
  privacy_profile: "local-first",
  config_path: "~/.sage/config.json",
});

export const HERMES_SAGE_HOOK_PATH = join(HARBOUR_ROOT, "bin", "sage-hermes-hook.mjs");
export const HERMES_SAGE_HOOK_COMMAND = `node ${JSON.stringify(HERMES_SAGE_HOOK_PATH)}`;
export const HERMES_SAGE_HOOK_MATCHER = [
  "terminal",
  "bash",
  "exec",
  "shell",
  "web_fetch",
  "fetch",
  "write",
  "write_file",
  "edit",
  "read",
  "read_file",
  "apply_patch",
].join("|");

const LOCAL_FIRST_CONFIG = {
  url_check: { enabled: true, timeout_seconds: 5 },
  file_check: { enabled: true, timeout_seconds: 5 },
  package_check: { enabled: true, timeout_seconds: 5 },
  amsi_check: { enabled: true },
  pi_check: {
    enabled: false,
    max_content_length: 16384,
    high_risk_threshold: 0.99,
    medium_risk_threshold: 0.5,
  },
  heuristics_enabled: true,
  cache: {
    enabled: true,
    ttl_malicious_seconds: 3600,
    ttl_clean_seconds: 86400,
    path: "~/.sage/cache.json",
  },
  allowlist: { path: "~/.sage/allowlist.json" },
  exceptions: { path: "~/.sage/exceptions.json" },
  logging: {
    enabled: true,
    log_clean: false,
    path: "~/.sage/audit.jsonl",
    max_bytes: 5242880,
    max_files: 3,
  },
  sensitivity: "paranoid",
  disabled_threats: [],
  community_iq: false,
};

function sageDir() {
  return join(homedir(), ".sage");
}

export function sageConfigPath() {
  return join(sageDir(), "config.json");
}

function deepMergePreserve(base, override) {
  const next = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = deepMergePreserve(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function ensureSageLocalFirstConfig() {
  const dir = sageDir();
  const configPath = sageConfigPath();
  mkdirSync(dir, { recursive: true });

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      existing = {};
    }
  }

  const merged = deepMergePreserve(existing, LOCAL_FIRST_CONFIG);
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try { return configPath; } finally {
    try { chmodSync(configPath, 0o600); } catch {}
  }
}

export function sageResourceDirs() {
  return {
    threatsDir: join(SAGE_OPENCLAW_ROOT, "resources", "threats"),
    allowlistsDir: join(SAGE_OPENCLAW_ROOT, "resources", "allowlists"),
  };
}

function patchFileArtifacts(patch) {
  const artifacts = [];
  for (const line of String(patch || "").split("\n")) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+)/);
    if (match?.[1] && match[1] !== "/dev/null") {
      artifacts.push({ type: "file_path", value: match[1], context: "apply_patch" });
    }
  }
  return artifacts;
}

function commandFromInput(input) {
  return input.command || input.cmd || input.script || "";
}

function pathFromInput(input) {
  return input.file_path || input.path || input.filename || "";
}

export function normalizeSageToolPayload(toolName, toolInput = {}) {
  const normalizedTool = String(toolName || "").trim();
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const lower = normalizedTool.toLowerCase();

  if (["terminal", "bash", "exec", "shell", "command"].includes(lower)) {
    const command = String(commandFromInput(input));
    return {
      toolName: "Bash",
      toolInput: { ...input, command },
      artifacts: command ? [{ type: "command", value: command, context: "Bash" }] : [],
    };
  }

  if (["web_fetch", "webfetch", "fetch", "url"].includes(lower)) {
    const url = input.url || input.href || input.uri || "";
    return {
      toolName: "WebFetch",
      toolInput: { ...input, url },
      artifacts: url ? [{ type: "url", value: String(url), context: "WebFetch" }] : [],
    };
  }

  if (["write", "write_file"].includes(lower)) {
    const filePath = pathFromInput(input);
    const content = input.content || "";
    const artifacts = [];
    if (filePath) artifacts.push({ type: "file_path", value: String(filePath), context: "Write" });
    if (content) artifacts.push({ type: "content", value: String(content), context: `Write:${filePath || "unknown"}` });
    return {
      toolName: "Write",
      toolInput: { ...input, file_path: filePath, content },
      artifacts,
    };
  }

  if (["edit", "replace", "update_file"].includes(lower)) {
    const filePath = pathFromInput(input);
    const newString = input.new_string || input.content || "";
    const artifacts = [];
    if (filePath) artifacts.push({ type: "file_path", value: String(filePath), context: "Edit" });
    if (newString) artifacts.push({ type: "content", value: String(newString), context: `Edit:${filePath || "unknown"}` });
    return {
      toolName: "Edit",
      toolInput: { ...input, file_path: filePath, new_string: newString },
      artifacts,
    };
  }

  if (["read", "read_file"].includes(lower)) {
    const filePath = pathFromInput(input);
    return {
      toolName: "Read",
      toolInput: { ...input, file_path: filePath },
      artifacts: filePath ? [{ type: "file_path", value: String(filePath), context: "Read" }] : [],
    };
  }

  if (lower === "apply_patch") {
    return {
      toolName: "ApplyPatch",
      toolInput: input,
      artifacts: patchFileArtifacts(input.patch || input.input || ""),
    };
  }

  return { toolName: normalizedTool || "Unknown", toolInput: input, artifacts: [] };
}

export function sageBlockMessage(verdict) {
  const reasons = verdict.reasons?.length ? verdict.reasons.slice(0, 5).join("; ") : verdict.category;
  return [
    "Sage blocked this action.",
    `Decision: ${verdict.decision}`,
    `Severity: ${verdict.severity}`,
    `Category: ${verdict.category}`,
    `Reason: ${reasons}`,
  ].join("\n");
}

export async function evaluateSageToolCall({
  sessionId = `harbour-${randomUUID()}`,
  conversationId,
  agentRuntime = "harbour",
  hookType = "PreToolUse",
  toolName,
  toolInput = {},
  artifacts = [],
} = {}) {
  const { evaluateToolCall, nullLogger } = await getSageCore();
  const configPath = ensureSageLocalFirstConfig();
  const dirs = sageResourceDirs();
  const verdict = await evaluateToolCall(
    {
      sessionId,
      conversationId: conversationId || sessionId,
      agentRuntime,
      hookType,
      toolName,
      toolInput,
      artifacts,
    },
    { ...dirs, configPath, logger: nullLogger },
  );

  const allowed = verdict.decision === "allow";
  return {
    allowed,
    verdict,
    message: allowed ? "" : sageBlockMessage(verdict),
  };
}

export async function evaluateCommandWithSage(command, opts = {}) {
  const normalized = normalizeSageToolPayload("terminal", { command });
  return evaluateSageToolCall({
    sessionId: opts.sessionId,
    conversationId: opts.conversationId,
    agentRuntime: opts.agentRuntime || "harbour-workflow",
    toolName: normalized.toolName,
    toolInput: normalized.toolInput,
    artifacts: normalized.artifacts,
  });
}

export async function evaluateHermesHookPayload(payload = {}) {
  const toolName = payload.tool_name || payload.toolName || "";
  const toolInput = payload.tool_input || payload.args || {};
  const normalized = normalizeSageToolPayload(toolName, toolInput);
  return evaluateSageToolCall({
    sessionId: payload.session_id || payload.sessionId || "hermes-unknown",
    conversationId: payload.session_id || payload.sessionId || "hermes-unknown",
    agentRuntime: "hermes",
    toolName: normalized.toolName,
    toolInput: normalized.toolInput,
    artifacts: normalized.artifacts,
  });
}

function defaultRunCommand(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 15_000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    code: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

export function parseOpenClawSagePluginStatus(output) {
  const text = String(output || "");
  const sageLines = text
    .split(/\r?\n/)
    .filter(line => /@gendigital\/sage-openclaw|sage-openclaw|\bSage\b|Safety for Agents/i.test(line));
  const installed = sageLines.length > 0;
  const enabled = sageLines.some(line => /enabled/i.test(line));
  return { installed, enabled };
}

export function parseHermesSageHookStatus({ listOutput = "", doctorOutput = "", command = HERMES_SAGE_HOOK_COMMAND } = {}) {
  const list = String(listOutput || "");
  const doctor = String(doctorOutput || "");
  const configured = list.includes("pre_tool_call") && list.includes(command);
  const healthy = configured && /All shell hooks look healthy/i.test(doctor);
  return { configured, healthy };
}

export async function checkSageRuntimeCoverage(cli, opts = {}) {
  const runCommand = opts.runCommand || defaultRunCommand;

  if (cli === "openclaw") {
    const result = runCommand("openclaw", ["plugins", "list"], { timeoutMs: 15_000 });
    const status = parseOpenClawSagePluginStatus(`${result.stdout}\n${result.stderr}`);
    return {
      ok: result.code === 0 && status.installed && status.enabled,
      runtime: cli,
      status,
      detail: status.enabled ? "SAGE OpenClaw plugin enabled." : "OpenClaw SAGE plugin is missing or disabled.",
    };
  }

  if (cli === "hermes") {
    const list = runCommand("hermes", ["hooks", "list"], { timeoutMs: 15_000 });
    const doctor = runCommand("hermes", ["hooks", "doctor"], { timeoutMs: 15_000 });
    const status = parseHermesSageHookStatus({
      listOutput: `${list.stdout}\n${list.stderr}`,
      doctorOutput: `${doctor.stdout}\n${doctor.stderr}`,
    });
    return {
      ok: list.code === 0 && doctor.code === 0 && status.configured && status.healthy,
      runtime: cli,
      status,
      detail: status.healthy ? "Hermes SAGE pre_tool_call hook healthy." : "Hermes SAGE hook is missing, unapproved, or unhealthy.",
    };
  }

  return {
    ok: false,
    runtime: cli || "unknown",
    status: { configured: false },
    detail: `No SAGE runtime coverage is mapped for CLI provider "${cli || "unknown"}".`,
  };
}

export async function ensureSageRuntimeCoverage(cli, opts = {}) {
  const coverage = await checkSageRuntimeCoverage(cli, opts);
  if (!coverage.ok) {
    throw new Error(`SAGE runtime security hard gate failed: ${coverage.detail}`);
  }
  return coverage;
}
