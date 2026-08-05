import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBinary } from "./providers.mjs";

/**
 * Per-agent CLI permission policies.
 *
 * Every agent carries a `permissions` setting from the dashboard:
 *
 *   'enforced'     — the default. The agent's workspace must contain a valid
 *                    policy file in its CLI's OWN native format, and the runner
 *                    points the CLI at it. No policy file, no run: the run fails
 *                    closed with an actionable reason rather than silently
 *                    running unrestricted.
 *   'unrestricted' — a deliberate per-agent dashboard opt-out that restores the
 *                    legacy bypass flags. Cheap to start with, on the operator.
 *
 * Harbour never authors or edits the policy file's CONTENT — that's the
 * operator's (docs help). Harbour validates that it exists and is well-formed,
 * refuses configurations that can't work headless, and passes it to the CLI.
 *
 * Both CLIs need one non-obvious piece of host state before their workspace
 * policy is honored at all — see the trust helpers below.
 */

/** The two values an agent's `permissions` column may hold. */
export const PERMISSION_MODES = Object.freeze(["enforced", "unrestricted"]);

/**
 * Claude permission modes that work under `-p`. `bypassPermissions` is
 * deliberately absent: bypassing is the dashboard's Unrestricted toggle, not
 * something a workspace file may grant itself (that would make the dashboard
 * value a lie). `dontAsk` is the headless default — it auto-denies anything not
 * allow-listed instead of blocking on a prompt that has no UI.
 */
const CLAUDE_PERMISSION_MODES = Object.freeze([
  "dontAsk",
  "acceptEdits",
  "default",
  "manual",
  "plan",
  "auto",
]);
const CLAUDE_DEFAULT_PERMISSION_MODE = "dontAsk";

/** Codex sandbox modes a policy file may name. See resolveCodexPolicy. */
const CODEX_SANDBOX_MODES = Object.freeze(["read-only", "workspace-write"]);
const CODEX_DEFAULT_SANDBOX_MODE = "workspace-write";

const DOC_HINT =
  "See docs/guides/agent-permissions.md, or set this agent to Unrestricted in the dashboard to bypass permission checks deliberately.";

/**
 * Normalize an agent's `permissions` value fail-closed. ONLY the exact string
 * "unrestricted" opts out; a missing field (older server), a typo, or any other
 * junk resolves to "enforced". Getting this backwards would turn a
 * half-upgraded deployment into a fleet of unrestricted agents, so the
 * defaulting direction is the security property.
 */
export function normalizePermissions(value) {
  return value === "unrestricted" ? "unrestricted" : "enforced";
}

/**
 * Read a file only if it's a plain, non-empty regular file. lstat (not stat) so
 * a symlink is rejected rather than followed: a policy file symlinked to
 * /dev/null or to an attacker-writable path must not be trusted, and "the file
 * looks fine" is exactly the check an unrestricted-by-accident bug hides behind.
 *
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
function readPlainFile(file, label) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: false, reason: `${label} not found at ${file}.` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: `${label} at ${file} is a symlink — refusing to trust it.` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: `${label} at ${file} is not a regular file.` };
  }
  if (st.size === 0) {
    return { ok: false, reason: `${label} at ${file} is empty.` };
  }
  try {
    return { ok: true, content: fs.readFileSync(file, "utf-8") };
  } catch (err) {
    return { ok: false, reason: `${label} at ${file} could not be read: ${err.message}` };
  }
}

/**
 * Claude Code: the policy file is `<workspace>/.claude/settings.json`, the
 * CLI's own settings format (permissions.allow/deny/ask, defaultMode, hooks,
 * and the OS sandbox block).
 *
 * The runner passes it with `--settings` rather than relying on cwd discovery,
 * because several sandbox keys (`strictAllowlist`, credential `mask`,
 * `filesystem.disabled`) are IGNORED when they arrive from a repository's
 * project-scope settings and honored only from user/managed/--settings sources.
 * Discovery would silently drop exactly the keys that do the containing.
 */
function resolveClaudePolicy(workingDir) {
  const settingsPath = path.join(workingDir, ".claude", "settings.json");
  const read = readPlainFile(settingsPath, "Claude policy file (.claude/settings.json)");
  if (!read.ok) return { ok: false, reason: `${read.reason} ${DOC_HINT}` };

  let parsed;
  try {
    parsed = JSON.parse(read.content);
  } catch (err) {
    return { ok: false, reason: `${settingsPath} is not valid JSON: ${err.message}` };
  }

  const permissions = parsed?.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return {
      ok: false,
      reason: `${settingsPath} has no "permissions" object — an agent policy must declare one. ${DOC_HINT}`,
    };
  }

  const declared = permissions.defaultMode;
  if (declared === "bypassPermissions") {
    return {
      ok: false,
      reason: `${settingsPath} sets permissions.defaultMode "bypassPermissions". A workspace file may not grant itself a bypass — set this agent to Unrestricted in the dashboard instead, so the bypass is visible where agents are managed.`,
    };
  }
  if (declared !== undefined && !CLAUDE_PERMISSION_MODES.includes(declared)) {
    return {
      ok: false,
      reason: `${settingsPath} sets an unrecognized permissions.defaultMode "${declared}" — expected one of ${CLAUDE_PERMISSION_MODES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    mode: "enforced",
    cli: "claude",
    settingsPath,
    permissionMode: declared ?? CLAUDE_DEFAULT_PERMISSION_MODE,
  };
}

/**
 * Extract a TOP-LEVEL key from a TOML document — the lines before the first
 * `[table]` header. Deliberately not a TOML parser: we need exactly one scalar
 * (`sandbox_mode`) and adding a TOML dependency to the runner bundle to read it
 * would be a poor trade. Scoping to the pre-table region matters: a same-named
 * key inside some other table must not be mistaken for the real one, or a
 * policy could resolve to a sandbox mode its author never wrote.
 */
function topLevelTomlString(content, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`);
  for (const line of content.split("\n")) {
    if (/^\s*\[/.test(line)) break; // first table header ends the top-level region
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Whether `network_access = true` is set INSIDE the `[sandbox_workspace_write]`
 * table — the only place Codex reads it.
 *
 * The table scoping is the whole check. A bare `network_access = true` at top
 * level, or under some other table, is ignored by Codex: accepting it would pass
 * a policy whose sandbox still blocks loopback, which is precisely the run-killing
 * configuration this gate exists to refuse. Same reasoning as
 * topLevelTomlString — a key means nothing without its table.
 */
function hasNetworkAccess(content) {
  let inTable = false;
  for (const line of content.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      inTable = header[1].trim() === "sandbox_workspace_write";
      continue;
    }
    if (inTable && /^\s*network_access\s*=\s*true\b/.test(line)) return true;
  }
  return false;
}

/**
 * Codex: the policy file is `<workspace>/.codex/config.toml`, the CLI's own
 * config format. The real boundary is Codex's OS sandbox (`sandbox_mode`),
 * which confines writes to the workspace and blocks network egress; optional
 * `.codex/rules/*.rules` execpolicy files layer a command deny-list on top.
 *
 * The network check is not pedantry. Under `workspace-write` with Codex's
 * default `network_access = false`, spawned commands reach nothing at all —
 * loopback included. Harbour's entire run protocol is curl to the Harbour API
 * (set the title, post activity, set the final status), so such an agent could
 * do work and then be unable to report any of it; every run would end `failed`
 * via the finalize backstop, with a cause buried three layers down. Refusing
 * the policy up front, naming the key, is the honest failure.
 */
function resolveCodexPolicy(workingDir, deps) {
  const configPath = path.join(workingDir, ".codex", "config.toml");
  const read = readPlainFile(configPath, "Codex policy file (.codex/config.toml)");
  if (!read.ok) return { ok: false, reason: `${read.reason} ${DOC_HINT}` };

  const declared = topLevelTomlString(read.content, "sandbox_mode");
  const sandboxMode = declared ?? CODEX_DEFAULT_SANDBOX_MODE;

  if (declared === "danger-full-access") {
    return {
      ok: false,
      reason: `${configPath} sets sandbox_mode "danger-full-access", which disables the sandbox entirely. A workspace file may not grant itself a bypass — set this agent to Unrestricted in the dashboard instead, so the bypass is visible where agents are managed.`,
    };
  }
  if (!CODEX_SANDBOX_MODES.includes(sandboxMode)) {
    return {
      ok: false,
      reason: `${configPath} sets an unrecognized sandbox_mode "${sandboxMode}" — expected one of ${CODEX_SANDBOX_MODES.join(", ")}.`,
    };
  }
  if (sandboxMode === "read-only") {
    return {
      ok: false,
      reason: `${configPath} sets sandbox_mode "read-only", which blocks all network access — including the loopback calls this run uses to report its title, activity, and final status to Harbour. Use "workspace-write" with [sandbox_workspace_write] network_access = true. ${DOC_HINT}`,
    };
  }
  if (!hasNetworkAccess(read.content)) {
    return {
      ok: false,
      reason: `${configPath} does not enable network access. Codex's sandbox blocks every connection by default — including the loopback calls this run uses to report its title, activity, and final status to Harbour — so add:\n\n  [sandbox_workspace_write]\n  network_access = true\n\n${DOC_HINT}`,
    };
  }

  const rules = collectCodexRules(workingDir, deps);
  if (!rules.ok) return rules;

  return {
    ok: true,
    mode: "enforced",
    cli: "codex",
    configPath,
    sandboxMode,
    rulesFiles: rules.files,
  };
}

/**
 * Optional execpolicy rules under `<workspace>/.codex/rules/*.rules`. An absent
 * directory is fine — the sandbox is the boundary and rules are an extra
 * deny-list. But a rules file that's PRESENT and broken must fail the run: Codex
 * would skip it and the agent would run with a deny-list its author believes is
 * in force. Validation shells out to `codex execpolicy check`, injectable so
 * unit tests never spawn the CLI.
 */
function collectCodexRules(workingDir, deps) {
  const dir = path.join(workingDir, ".codex", "rules");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { ok: true, files: [] }; // no rules dir — the sandbox stands alone
  }

  const check = deps?.checkRulesFile ?? checkRulesFileWithCodex;
  const files = entries
    .filter((name) => name.endsWith(".rules"))
    .map((name) => path.join(dir, name))
    .sort();

  for (const file of files) {
    const read = readPlainFile(file, "Codex execpolicy rules file");
    if (!read.ok) return { ok: false, reason: `${read.reason} ${DOC_HINT}` };
    const result = check(file);
    if (!result?.ok) {
      return {
        ok: false,
        reason: `Codex rejected the execpolicy rules at ${file}: ${result?.error || "unknown parse error"}`,
      };
    }
  }
  return { ok: true, files };
}

/** Wallclock cap for the rules validator. It normally answers in well under a second. */
const RULES_CHECK_TIMEOUT_MS = 10_000;

/**
 * Validate one `.rules` file by asking Codex itself to parse it. `execpolicy
 * check` exits 0 and prints a JSON verdict for a parseable file; a parse error
 * goes to stderr with a non-zero exit — so the exit code is the signal and the
 * stderr text is the operator's error message. `-- true` is a throwaway command
 * to check the rules against; we only care whether the file loaded.
 *
 * This runs synchronously before the CLI spawns, so it sits outside the runner's
 * inactivity timer — a hung validator would stall the run with nothing to kill
 * it. Hence the explicit timeout, and the distinction below: only a real
 * non-zero EXIT (`err.status` is a number) is Codex rejecting the file. A
 * timeout, a signal, or a spawn failure means we could not validate it, which is
 * the same position as codex not being installed — pass rather than fail a run
 * over an unverifiable secondary check. The sandbox, not the rules file, is the
 * boundary; rules are a tripwire on top of it.
 */
function checkRulesFileWithCodex(file) {
  const binary = resolveBinary("codex");
  if (!binary) {
    // Can't validate without the CLI. The run would fail at spawn anyway with a
    // clearer message, so don't block here on an unverifiable file.
    return { ok: true };
  }
  try {
    execFileSync(binary, ["execpolicy", "check", "--rules", file, "--", "true"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RULES_CHECK_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    if (typeof err?.status !== "number") return { ok: true }; // unverifiable, not rejected
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    return { ok: false, error: detail.split("\n").slice(0, 3).join(" ") };
  }
}

/**
 * Resolve the effective permission policy for one run, before the CLI spawns.
 *
 * @param {{ cli: string, workingDir: string, permissions?: string }} args
 * @param {{ checkRulesFile?: (file: string) => { ok: boolean, error?: string } }} [deps]
 * @returns {{ ok: true, mode: 'unrestricted' }
 *          | { ok: true, mode: 'enforced', cli: 'claude', settingsPath: string, permissionMode: string }
 *          | { ok: true, mode: 'enforced', cli: 'codex', configPath: string, sandboxMode: string, rulesFiles: string[] }
 *          | { ok: false, reason: string }}
 */
export function resolveAgentPolicy({ cli, workingDir, permissions }, deps) {
  if (normalizePermissions(permissions) === "unrestricted") {
    return { ok: true, mode: "unrestricted" };
  }
  if (cli === "claude") return resolveClaudePolicy(workingDir);
  if (cli === "codex") return resolveCodexPolicy(workingDir, deps);
  return {
    ok: false,
    reason: `No permission policy is defined for CLI "${cli}" — Harbour can only enforce policies for claude and codex.`,
  };
}

/**
 * Claude Code silently DROPS `permissions.allow` entries from a workspace it
 * doesn't consider trusted ("Ignoring 1 permissions.allow entry … this
 * workspace has not been trusted" on stderr) while still applying deny rules.
 * An untrusted enforced agent therefore boots with allow-nothing and can only
 * run built-in read-only commands — it looks alive and does nothing. Trust is
 * normally granted by an interactive dialog no headless runner will ever see,
 * so the runner records it directly.
 *
 * Merges into `~/.claude.json` rather than rewriting it: that file holds the
 * operator's own Claude state. A file we can't parse is left completely alone —
 * a warning beats destroying it.
 *
 * @returns {{ changed: boolean, warning?: string }}
 */
export function ensureClaudeWorkspaceTrust(workingDir, { configPath } = {}) {
  const file = configPath || path.join(os.homedir(), ".claude.json");
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return {
        changed: false,
        warning: `Could not parse ${file}, so this workspace could not be marked trusted. Claude Code will ignore the agent's permissions.allow rules until you open the workspace interactively once and accept the trust dialog.`,
      };
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { changed: false, warning: `${file} is not a JSON object — leaving it untouched.` };
  }

  const projects = config.projects && typeof config.projects === "object" ? config.projects : {};
  const existing = projects[workingDir];
  if (existing?.hasTrustDialogAccepted === true) return { changed: false };

  config.projects = {
    ...projects,
    [workingDir]: {
      ...(existing && typeof existing === "object" ? existing : {}),
      hasTrustDialogAccepted: true,
    },
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return { changed: true };
  } catch (err) {
    return { changed: false, warning: `Could not write ${file}: ${err.message}` };
  }
}

/**
 * Codex only loads a workspace's `.codex/` layer (config.toml, rules/) when the
 * directory is trusted, recorded as a `[projects."<dir>"]` table in
 * `$CODEX_HOME/config.toml`. Appends the entry when absent; never rewrites
 * existing content (that file is the operator's own Codex config).
 *
 * The runner also passes `-s <mode>` explicitly, so the sandbox holds even if
 * trust resolution ever changes upstream — this makes the rest of the policy
 * file (network access, writable roots, rules) take effect.
 *
 * @returns {{ changed: boolean, warning?: string }}
 */
export function ensureCodexWorkspaceTrust(workingDir, { codexHome } = {}) {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = path.join(home, "config.toml");
  const header = `[projects.${JSON.stringify(workingDir)}]`;

  let content = "";
  if (fs.existsSync(file)) {
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (err) {
      return { changed: false, warning: `Could not read ${file}: ${err.message}` };
    }
    if (content.includes(header)) return { changed: false };
  }

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${content}${separator}\n${header}\ntrust_level = "trusted"\n`);
    return { changed: true };
  } catch (err) {
    return { changed: false, warning: `Could not write ${file}: ${err.message}` };
  }
}

/**
 * Scrape Claude Code's "Ignoring N permissions.<kind> entr(y|ies)…" warnings
 * out of stderr. These are the CLI telling us a policy rule didn't apply —
 * usually untrusted workspace or a malformed pattern. Silent on stderr, they
 * turn into an agent that mysteriously refuses everything, so the runner
 * surfaces them as run activity where the operator will actually see them.
 */
export function extractPermissionWarnings(stderr) {
  if (typeof stderr !== "string" || !stderr) return [];
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^Ignoring \d+ permissions\./.test(line));
}

/**
 * Human-readable one-liner for logs and the `harbour policy` CLI.
 * @param {object} policy - a resolveAgentPolicy result
 */
export function describePolicy(policy) {
  if (!policy?.ok) return `invalid — ${policy?.reason ?? "unknown"}`;
  if (policy.mode === "unrestricted") return "unrestricted (permission checks bypassed)";
  if (policy.cli === "claude")
    return `enforced via .claude/settings.json (${policy.permissionMode})`;
  return `enforced via .codex/config.toml (${policy.sandboxMode})`;
}
