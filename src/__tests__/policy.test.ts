import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureClaudeWorkspaceTrust,
  ensureCodexWorkspaceTrust,
  extractPermissionWarnings,
  resolveAgentPolicy,
} from "../../bin/lib/policy.mjs";
import { resolveBinary } from "../../bin/lib/providers.mjs";

// The permission-policy contract: an agent with permissions="enforced" (the
// default) must have a valid CLI-native policy file in its workspace or the
// runner refuses the run (fail closed). "unrestricted" is the deliberate
// dashboard opt-out that restores the legacy bypass flags. Every failure mode
// here — missing, empty, symlinked, corrupt, half-configured — must resolve to
// ok:false, never to a silent fallback into bypass mode.

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-policy-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function writeClaudeSettings(content: string) {
  const dir = path.join(ws, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, content);
  return file;
}

function writeCodexRules(name: string, content: string) {
  const dir = path.join(ws, ".codex", "rules");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

// A workable codex policy: the sandbox confines writes to the workspace, and
// network_access is on because the Harbour run protocol is curl-to-Harbour and
// the sandbox blocks even loopback without it.
const CODEX_CONFIG = [
  'sandbox_mode = "workspace-write"',
  "",
  "[sandbox_workspace_write]",
  "network_access = true",
  "",
].join("\n");

function writeCodexConfig(content: string) {
  const dir = path.join(ws, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, content);
  return file;
}

const okCheck = () => ({ ok: true });

describe("resolveAgentPolicy — unrestricted", () => {
  it("returns unrestricted without touching the filesystem", () => {
    // No workspace files exist at all — unrestricted must not care.
    const policy = resolveAgentPolicy({
      cli: "claude",
      workingDir: ws,
      permissions: "unrestricted",
    });
    expect(policy).toEqual({ ok: true, mode: "unrestricted" });
  });

  it("applies to codex the same way", () => {
    const policy = resolveAgentPolicy({
      cli: "codex",
      workingDir: ws,
      permissions: "unrestricted",
    });
    expect(policy).toEqual({ ok: true, mode: "unrestricted" });
  });
});

describe("resolveAgentPolicy — claude enforced", () => {
  it("accepts a valid settings file and defaults permissionMode to dontAsk", () => {
    const file = writeClaudeSettings(JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" });
    expect(policy).toEqual({
      ok: true,
      mode: "enforced",
      cli: "claude",
      settingsPath: file,
      permissionMode: "dontAsk",
    });
  });

  it("honors the file's own defaultMode when it is a safe headless mode", () => {
    writeClaudeSettings(
      JSON.stringify({ permissions: { defaultMode: "acceptEdits", allow: ["Bash(curl *)"] } }),
    );
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" });
    expect(policy).toMatchObject({ ok: true, mode: "enforced", permissionMode: "acceptEdits" });
  });

  it("rejects defaultMode bypassPermissions — bypass belongs to the dashboard toggle", () => {
    writeClaudeSettings(JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toMatch(/bypassPermissions/);
  });

  it("rejects an unknown defaultMode instead of guessing", () => {
    writeClaudeSettings(JSON.stringify({ permissions: { defaultMode: "yolo" } }));
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(false);
  });

  it("fails closed when the settings file is missing", () => {
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toContain(".claude/settings.json");
  });

  it("fails closed on an empty file", () => {
    writeClaudeSettings("");
    expect(resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" }).ok).toBe(
      false,
    );
  });

  it("fails closed on corrupt JSON", () => {
    writeClaudeSettings("{ not json");
    expect(resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" }).ok).toBe(
      false,
    );
  });

  it("fails closed when the permissions key is missing", () => {
    writeClaudeSettings(JSON.stringify({ model: "sonnet" }));
    expect(resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" }).ok).toBe(
      false,
    );
  });

  it("fails closed when permissions is not an object (array, null, string)", () => {
    for (const bad of [
      JSON.stringify({ permissions: [] }),
      JSON.stringify({ permissions: null }),
      JSON.stringify({ permissions: "all" }),
    ]) {
      writeClaudeSettings(bad);
      expect(
        resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" }).ok,
        bad,
      ).toBe(false);
    }
  });

  it("fails closed when settings.json is a symlink", () => {
    const target = path.join(ws, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify({ permissions: {} }));
    const dir = path.join(ws, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, "settings.json"));
    expect(resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "enforced" }).ok).toBe(
      false,
    );
  });
});

describe("resolveAgentPolicy — codex enforced", () => {
  function resolve(deps: Record<string, unknown> = { checkRulesFile: okCheck }) {
    return resolveAgentPolicy({ cli: "codex", workingDir: ws, permissions: "enforced" }, deps);
  }

  it("accepts a config.toml with a confining sandbox and network on", () => {
    const file = writeCodexConfig(CODEX_CONFIG);
    expect(resolve()).toEqual({
      ok: true,
      mode: "enforced",
      cli: "codex",
      configPath: file,
      sandboxMode: "workspace-write",
      rulesFiles: [],
    });
  });

  it("defaults sandboxMode to workspace-write when the key is absent", () => {
    // Codex's own default. network_access must still be present for the run
    // protocol to work, so the file has to opt in explicitly.
    writeCodexConfig("[sandbox_workspace_write]\nnetwork_access = true\n");
    expect(resolve()).toMatchObject({ ok: true, sandboxMode: "workspace-write" });
  });

  it("rejects danger-full-access — bypass belongs to the dashboard toggle", () => {
    writeCodexConfig('sandbox_mode = "danger-full-access"\n');
    const policy = resolve();
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toMatch(/danger-full-access/);
  });

  it("rejects an unknown sandbox_mode", () => {
    writeCodexConfig('sandbox_mode = "wide-open"\n');
    expect(resolve().ok).toBe(false);
  });

  it("fails closed when network_access is missing — the run protocol needs Harbour", () => {
    // Verified: workspace-write with network off blocks even loopback, so the
    // agent could never post a status and every run would fail at finalize.
    writeCodexConfig('sandbox_mode = "workspace-write"\n');
    const policy = resolve();
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toMatch(/network_access/);
  });

  it("fails closed when network_access is explicitly false", () => {
    writeCodexConfig(
      'sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = false\n',
    );
    expect(resolve().ok).toBe(false);
  });

  it("only counts network_access inside [sandbox_workspace_write], not any table", () => {
    // Codex reads the key only from that table. Accepting it elsewhere would
    // pass a policy whose sandbox still blocks loopback — the exact run-killing
    // configuration this gate exists to refuse.
    writeCodexConfig(
      [
        'sandbox_mode = "workspace-write"',
        "",
        "[sandbox_workspace_write]",
        "network_access = false",
        "",
        "[some_other_table]",
        "network_access = true",
        "",
      ].join("\n"),
    );
    expect(resolve().ok).toBe(false);
  });

  it("ignores a bare top-level network_access outside any table", () => {
    writeCodexConfig('sandbox_mode = "workspace-write"\nnetwork_access = true\n');
    expect(resolve().ok).toBe(false);
  });

  it("accepts the key when the table is re-opened later in the file", () => {
    writeCodexConfig(
      [
        'sandbox_mode = "workspace-write"',
        "",
        "[other]",
        "x = 1",
        "",
        "[sandbox_workspace_write]",
        'writable_roots = ["/tmp/build"]',
        "network_access = true",
        "",
      ].join("\n"),
    );
    expect(resolve().ok).toBe(true);
  });

  it("fails closed on read-only — it cannot reach Harbour either", () => {
    writeCodexConfig('sandbox_mode = "read-only"\n');
    const policy = resolve();
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toMatch(/read-only/);
  });

  it("ignores a sandbox_mode that appears under a section header, not at top level", () => {
    // Only the top-level key governs; a same-named key inside a table must not
    // be mistaken for it (that would silently pick the wrong mode).
    writeCodexConfig(
      '[some_table]\nsandbox_mode = "danger-full-access"\n\n[sandbox_workspace_write]\nnetwork_access = true\n',
    );
    expect(resolve()).toMatchObject({ ok: true, sandboxMode: "workspace-write" });
  });

  it("fails closed when config.toml is missing", () => {
    const policy = resolve();
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toContain(".codex/config.toml");
  });

  it("fails closed on an empty config.toml", () => {
    writeCodexConfig("");
    expect(resolve().ok).toBe(false);
  });

  it("fails closed when config.toml is a symlink", () => {
    const target = path.join(ws, "elsewhere.toml");
    fs.writeFileSync(target, CODEX_CONFIG);
    const dir = path.join(ws, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, "config.toml"));
    expect(resolve().ok).toBe(false);
  });
});

describe("resolveAgentPolicy — codex optional execpolicy rules", () => {
  function resolve(deps: Record<string, unknown> = { checkRulesFile: okCheck }) {
    return resolveAgentPolicy({ cli: "codex", workingDir: ws, permissions: "enforced" }, deps);
  }

  beforeEach(() => {
    writeCodexConfig(CODEX_CONFIG);
  });

  it("collects valid rules files sorted by path", () => {
    const b = writeCodexRules("b.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const a = writeCodexRules("a.rules", 'prefix_rule(pattern=["ssh"], decision="forbidden")\n');
    expect(resolve()).toMatchObject({ ok: true, rulesFiles: [a, b] });
  });

  it("ignores non-.rules files in the rules dir", () => {
    const dir = path.join(ws, ".codex", "rules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "notes");
    expect(resolve()).toMatchObject({ ok: true, rulesFiles: [] });
  });

  it("fails closed when a rules file does not parse, carrying the error", () => {
    writeCodexRules("bad.rules", "this is not starlark(((\n");
    const policy = resolve({
      checkRulesFile: () => ({ ok: false, error: "failed to parse policy" }),
    });
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toContain("failed to parse policy");
  });

  it("fails closed on a zero-byte rules file", () => {
    writeCodexRules("empty.rules", "");
    expect(resolve().ok).toBe(false);
  });

  it("fails closed on a symlinked rules file", () => {
    const target = path.join(ws, "real.rules");
    fs.writeFileSync(target, "x = 1\n");
    const dir = path.join(ws, ".codex", "rules");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, "link.rules"));
    expect(resolve().ok).toBe(false);
  });
});

describe("resolveAgentPolicy — defensive edges", () => {
  it("treats an unknown permissions value as enforced (fail closed), never unrestricted", () => {
    // No policy file exists, so enforced resolution must fail — proving the
    // junk value didn't fall through to bypass.
    const policy = resolveAgentPolicy({ cli: "claude", workingDir: ws, permissions: "yolo" });
    expect(policy.ok).toBe(false);
  });

  it("fails closed for an unknown cli", () => {
    const policy = resolveAgentPolicy({ cli: "cursor", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(false);
  });
});

describe("ensureClaudeWorkspaceTrust", () => {
  let configPath: string;

  beforeEach(() => {
    configPath = path.join(ws, "claude-config.json");
  });

  it("creates the config file with the trust flag when missing", () => {
    const res = ensureClaudeWorkspaceTrust("/ws/agent", { configPath });
    expect(res.changed).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(parsed.projects["/ws/agent"].hasTrustDialogAccepted).toBe(true);
  });

  it("preserves unrelated keys and other projects", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        theme: "dark",
        projects: { "/other": { hasTrustDialogAccepted: true, history: [1] } },
      }),
    );
    ensureClaudeWorkspaceTrust("/ws/agent", { configPath });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.projects["/other"]).toEqual({ hasTrustDialogAccepted: true, history: [1] });
    expect(parsed.projects["/ws/agent"].hasTrustDialogAccepted).toBe(true);
  });

  it("preserves the workspace's existing project state when adding the flag", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ projects: { "/ws/agent": { history: ["old"] } } }),
    );
    ensureClaudeWorkspaceTrust("/ws/agent", { configPath });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(parsed.projects["/ws/agent"].history).toEqual(["old"]);
    expect(parsed.projects["/ws/agent"].hasTrustDialogAccepted).toBe(true);
  });

  it("is idempotent — already-trusted returns changed:false without rewriting", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ projects: { "/ws/agent": { hasTrustDialogAccepted: true } } }),
    );
    const before = fs.statSync(configPath).mtimeMs;
    const res = ensureClaudeWorkspaceTrust("/ws/agent", { configPath });
    expect(res.changed).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
  });

  it("never clobbers a config it cannot parse — returns a warning instead", () => {
    fs.writeFileSync(configPath, "{ definitely not json");
    const res = ensureClaudeWorkspaceTrust("/ws/agent", { configPath });
    expect(res.changed).toBe(false);
    expect(res.warning).toBeTruthy();
    expect(fs.readFileSync(configPath, "utf-8")).toBe("{ definitely not json");
  });
});

describe("ensureCodexWorkspaceTrust", () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = path.join(ws, "codex-home");
  });

  it("creates config.toml with the trust entry when missing", () => {
    const res = ensureCodexWorkspaceTrust("/ws/agent", { codexHome });
    expect(res.changed).toBe(true);
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    expect(toml).toContain('[projects."/ws/agent"]');
    expect(toml).toContain('trust_level = "trusted"');
  });

  it("appends to an existing config.toml without disturbing other content", () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const existing = 'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    ensureCodexWorkspaceTrust("/ws/agent", { codexHome });
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    expect(toml.startsWith(existing)).toBe(true);
    expect(toml).toContain('[projects."/ws/agent"]');
  });

  it("is idempotent — an existing entry is left alone", () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const existing = '[projects."/ws/agent"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), existing);
    const res = ensureCodexWorkspaceTrust("/ws/agent", { codexHome });
    expect(res.changed).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe(existing);
  });
});

// Everything above injects `checkRulesFile`, so the ONE path that shells out —
// asking the real codex CLI to parse a rules file — would otherwise be untested.
// These run the genuine validator, so they're skipped when codex isn't on PATH
// (CI, a claude-only runner) rather than failing there.
describe("codex rules validation against the real CLI", () => {
  const codex = resolveBinary("codex");

  it.skipIf(!codex)("accepts a rules file codex can parse", () => {
    writeCodexConfig(CODEX_CONFIG);
    writeCodexRules("good.rules", 'prefix_rule(pattern=["git", "push"], decision="forbidden")\n');
    const policy = resolveAgentPolicy({ cli: "codex", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(true);
  });

  it.skipIf(!codex)("rejects a rules file codex cannot parse, surfacing its error", () => {
    // A parse error is a non-zero exit with the reason on stderr — the only
    // signal that means "codex rejected this", as opposed to unverifiable.
    writeCodexConfig(CODEX_CONFIG);
    writeCodexRules("bad.rules", "this is not starlark(((\n");
    const policy = resolveAgentPolicy({ cli: "codex", workingDir: ws, permissions: "enforced" });
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toMatch(/parse/i);
  });
}, 30_000);

describe("extractPermissionWarnings", () => {
  it("extracts claude's ignored-permission-entry warnings", () => {
    const stderr = [
      "some noise",
      "Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog.",
      "more noise",
    ].join("\n");
    const warnings = extractPermissionWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("permissions.allow");
  });

  it("handles the plural form and multiple kinds", () => {
    const stderr =
      "Ignoring 3 permissions.deny entries from .claude/settings.json: bad pattern\nIgnoring 2 permissions.allow entries from .claude/settings.json: nope";
    expect(extractPermissionWarnings(stderr)).toHaveLength(2);
  });

  it("returns [] for clean stderr and non-string input", () => {
    expect(extractPermissionWarnings("all good")).toEqual([]);
    expect(extractPermissionWarnings("")).toEqual([]);
    expect(extractPermissionWarnings(undefined as unknown as string)).toEqual([]);
  });
});
