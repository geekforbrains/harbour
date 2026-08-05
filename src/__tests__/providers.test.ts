import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_CONFIG } from "@/lib/cli-config";
import { slugify } from "@/lib/slug";
import {
  detectCapabilities,
  ensureWorkingDir,
  getProvider,
  resetBinaryCache,
  resolveBinary,
  runCliTool,
  sanitizeThinking,
  WORKSPACE_SEGMENT_RE,
} from "../../bin/lib/providers.mjs";

// These tests assert the argv shape produced by each provider's buildCommand.
// They guard against silent flag drift in the upstream CLIs. When upgrading a
// CLI, update both the provider and these expectations together so the change
// is visible in review.

const CWD = "/tmp/test-workspace";
const PROMPT = "do the thing";

// Policy fixtures — buildCommand demands a resolved policy (7th param). The
// bypass flags exist ONLY behind mode:"unrestricted"; enforced mode carries the
// CLI-native config resolveAgentPolicy validated.
const UNRESTRICTED = { ok: true, mode: "unrestricted" };
const ENFORCED_CLAUDE = {
  ok: true,
  mode: "enforced",
  cli: "claude",
  settingsPath: `${CWD}/.claude/settings.json`,
  permissionMode: "dontAsk",
};
const ENFORCED_CODEX = {
  ok: true,
  mode: "enforced",
  cli: "codex",
  configPath: `${CWD}/.codex/config.toml`,
  sandboxMode: "workspace-write",
  rulesFiles: [`${CWD}/.codex/rules/harbour.rules`],
};

describe("claude provider", () => {
  const claude = getProvider("claude");

  it("builds a basic command without thinking", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "abc-123", true, null, UNRESTRICTED);
    expect(cmd.cwd).toBe(CWD);
    expect(cmd.args).toContain("-p");
    expect(cmd.args).toContain(PROMPT);
    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("sonnet");
    expect(cmd.args).not.toContain("--effort");
  });

  it("passes thinking via --effort", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "abc-123", true, "high", UNRESTRICTED);
    expect(cmd.args).toContain("--effort");
    const effortIdx = cmd.args.indexOf("--effort");
    expect(cmd.args[effortIdx + 1]).toBe("high");
  });

  it("uses --session-id for new sessions and --resume for existing", () => {
    const fresh = claude.buildCommand(PROMPT, "sonnet", CWD, "uuid-1", true, null, UNRESTRICTED);
    expect(fresh.args).toContain("--session-id");
    expect(fresh.args).not.toContain("--resume");

    const resume = claude.buildCommand(PROMPT, "sonnet", CWD, "uuid-1", false, null, UNRESTRICTED);
    expect(resume.args).toContain("--resume");
    expect(resume.args).not.toContain("--session-id");
  });
});

describe("claude provider — permission policy argv", () => {
  const claude = getProvider("claude");

  it("unrestricted mode passes the bypass flag", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "u", true, null, UNRESTRICTED);
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.args).not.toContain("--settings");
  });

  it("enforced mode passes settings/permission-mode/setting-sources and never the bypass flag", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "u", true, null, ENFORCED_CLAUDE);
    expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    expect(cmd.args[cmd.args.indexOf("--settings") + 1]).toBe(ENFORCED_CLAUDE.settingsPath);
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(cmd.args[cmd.args.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("enforced mode carries the policy file's own permissionMode", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "u", true, null, {
      ...ENFORCED_CLAUDE,
      permissionMode: "acceptEdits",
    });
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("enforced flags survive on a resumed session too", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "u", false, null, ENFORCED_CLAUDE);
    expect(cmd.args).toContain("--resume");
    expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    expect(cmd.args).toContain("--settings");
  });

  it("throws without a resolved policy — no silent fallback into bypass", () => {
    expect(() => claude.buildCommand(PROMPT, "sonnet", CWD, "u", true, null)).toThrow(/policy/i);
    expect(() =>
      claude.buildCommand(PROMPT, "sonnet", CWD, "u", true, null, { ok: false, reason: "x" }),
    ).toThrow(/policy/i);
  });
});

describe("codex provider (issue #24)", () => {
  const codex = getProvider("codex");

  it("does NOT use the removed --reasoning-effort flag", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, "low", UNRESTRICTED);
    expect(cmd.args).not.toContain("--reasoning-effort");
  });

  it("passes thinking via -c model_reasoning_effort=<level> on a fresh session", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, "high", UNRESTRICTED);
    expect(cmd.args).toContain("-c");
    expect(cmd.args).toContain("model_reasoning_effort=high");
    // The -c and its value must be adjacent
    const cIdx = cmd.args.indexOf("-c");
    expect(cmd.args[cIdx + 1]).toBe("model_reasoning_effort=high");
  });

  it("passes thinking via -c on a resumed session", () => {
    const cmd = codex.buildCommand(
      PROMPT,
      "gpt-5",
      CWD,
      "session-uuid",
      false,
      "medium",
      UNRESTRICTED,
    );
    expect(cmd.args[0]).toBe("exec");
    expect(cmd.args[1]).toBe("resume");
    expect(cmd.args).toContain("-c");
    expect(cmd.args).toContain("model_reasoning_effort=medium");
    expect(cmd.args).not.toContain("--reasoning-effort");
    // Session id and prompt must be the trailing positional args
    expect(cmd.args[cmd.args.length - 2]).toBe("session-uuid");
    expect(cmd.args[cmd.args.length - 1]).toBe(PROMPT);
  });

  it("omits model_reasoning_effort when no thinking value is set", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null, UNRESTRICTED);
    expect(cmd.args.join(" ")).not.toContain("model_reasoning_effort");
  });
});

describe("codex provider — permission policy argv", () => {
  const codex = getProvider("codex");

  it("unrestricted mode passes the bypass flag (fresh and resume)", () => {
    const fresh = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null, UNRESTRICTED);
    expect(fresh.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const resume = codex.buildCommand(PROMPT, "gpt-5", CWD, "sid", false, null, UNRESTRICTED);
    expect(resume.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("enforced mode drops the bypass flag and pins approval_policy=never (fresh and resume)", () => {
    for (const [sessionId, isNew] of [
      [null, true],
      ["sid", false],
    ] as const) {
      const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, sessionId, isNew, null, ENFORCED_CODEX);
      expect(cmd.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const cIdx = cmd.args.indexOf("-c");
      expect(cmd.args[cIdx + 1]).toBe("approval_policy=never");
    }
  });

  it("enforced mode passes the policy file's sandbox mode via -s", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null, ENFORCED_CODEX);
    expect(cmd.args[cmd.args.indexOf("-s") + 1]).toBe("workspace-write");
  });

  it("enforced mode passes --skip-git-repo-check — agent workspaces are not git repos", () => {
    // Without it codex refuses to start ("Not inside a trusted directory and
    // --skip-git-repo-check was not specified"). The bypass flag implied it.
    const fresh = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null, ENFORCED_CODEX);
    expect(fresh.args).toContain("--skip-git-repo-check");
    const resume = codex.buildCommand(PROMPT, "gpt-5", CWD, "sid", false, null, ENFORCED_CODEX);
    expect(resume.args).toContain("--skip-git-repo-check");
  });

  it("keeps exec/resume leading and sessionId+prompt trailing in enforced mode", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, "sid", false, "high", ENFORCED_CODEX);
    expect(cmd.args[0]).toBe("exec");
    expect(cmd.args[1]).toBe("resume");
    expect(cmd.args[cmd.args.length - 2]).toBe("sid");
    expect(cmd.args[cmd.args.length - 1]).toBe(PROMPT);
  });

  it("throws without a resolved policy — no silent fallback into bypass", () => {
    expect(() => codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null)).toThrow(/policy/i);
  });
});

describe("codex createParser", () => {
  function agentMessage(text: string) {
    return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  }

  it("inserts a paragraph break before each agent message after the first", () => {
    // Codex emits complete, distinct agent_message items (narration before
    // tool calls, then a summary). Consumers join text_delta events with "" —
    // without separators the messages run together into one blob.
    const parser = getProvider("codex").createParser();

    const first = parser.parseLine(agentMessage("First message."));
    const second = parser.parseLine(agentMessage("Second message."));

    expect(first.events[0].content).toBe("First message.");
    expect(second.events[0].content).toBe("\n\nSecond message.");
  });

  it("does not prefix the first message when earlier lines emitted no text", () => {
    const parser = getProvider("codex").createParser();

    parser.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    const first = parser.parseLine(agentMessage("Hello."));

    expect(first.events[0].content).toBe("Hello.");
  });
});

// Issue #39: a thinking level the CLI doesn't accept (e.g. "off", written via
// the API before validation existed, or left behind by CLI version drift) must
// not fail the run. The runner sanitizes the resolved level before building
// the command: known levels pass, unknown ones are dropped and reported so the
// run proceeds on the CLI default.
describe("sanitizeThinking (issue #39)", () => {
  it("passes a known level through", () => {
    expect(sanitizeThinking("claude", "high")).toEqual({ thinking: "high", dropped: null });
    expect(sanitizeThinking("codex", "xhigh")).toEqual({ thinking: "xhigh", dropped: null });
  });

  it("drops an unknown level instead of failing the run", () => {
    expect(sanitizeThinking("claude", "off")).toEqual({ thinking: null, dropped: "off" });
  });

  it("treats empty as unset", () => {
    expect(sanitizeThinking("claude", null)).toEqual({ thinking: null, dropped: null });
    expect(sanitizeThinking("claude", "")).toEqual({ thinking: null, dropped: null });
    expect(sanitizeThinking("claude", undefined)).toEqual({ thinking: null, dropped: null });
  });

  it("silently drops for an unknown cli", () => {
    expect(sanitizeThinking("cursor", "high")).toEqual({ thinking: null, dropped: null });
  });
});

// The dashboard/API validate against CLI_CONFIG (src/lib/cli-config.ts); the
// runner sanitizes against each provider's thinkingLevels. These are two
// bundles (TS app vs plain-JS runner) so the lists are duplicated by
// necessity — this test locks them together so they can't drift.
describe("provider thinkingLevels match CLI_CONFIG", () => {
  for (const [cli, config] of Object.entries(CLI_CONFIG)) {
    it(`${cli}: thinkingLevels === CLI_CONFIG.${cli}.thinkingOptions`, () => {
      expect(getProvider(cli).thinkingLevels).toEqual(config.thinkingOptions);
    });
  }
});

describe("removed providers", () => {
  it("does not expose gemini", () => {
    expect(() => getProvider("gemini")).toThrow("Unknown CLI provider: gemini");
  });
});

// ---------------------------------------------------------------------------
// runCliTool inactivity timer (issue #15)
//
// A single inactivity timer replaces the old 30s startup timer + fixed
// wallclock spawn timeout. It resets on every chunk of output, so a streaming
// agent never gets killed at an arbitrary cap; a silent process (startup hang
// or mid-run stall) is SIGTERM'd after the window. The resolved object carries
// `timedOut` so the runner can report the cause precisely.
// ---------------------------------------------------------------------------
describe("runCliTool inactivity timer (issue #15)", () => {
  const NODE = process.execPath;

  it("kills a process that produces output then goes silent past the window", async () => {
    const script = `process.stdout.write("hello\\n"); setInterval(() => {}, 1000);`;
    const res = await runCliTool(NODE, ["-e", script], process.cwd(), {
      inactivityTimeoutMs: 300,
      killGraceMs: 150,
    });
    expect(res.timedOut).toBe(true);
  }, 8000);

  it("kills a process that never produces any output (startup hang)", async () => {
    const script = `setInterval(() => {}, 1000);`;
    const res = await runCliTool(NODE, ["-e", script], process.cwd(), {
      inactivityTimeoutMs: 300,
      killGraceMs: 150,
    });
    expect(res.timedOut).toBe(true);
  }, 8000);

  it("does NOT kill a process that keeps streaming within the window", async () => {
    // Emit a line every 50ms (< 300ms window) for ~450ms, then exit cleanly.
    const script = `let n = 0; const t = setInterval(() => { process.stdout.write("tick " + (n++) + "\\n"); if (n >= 9) { clearInterval(t); process.exit(0); } }, 50);`;
    const lines: string[] = [];
    const res = await runCliTool(NODE, ["-e", script], process.cwd(), {
      inactivityTimeoutMs: 300,
      killGraceMs: 150,
      onLine: (l: string) => lines.push(l),
    });
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    expect(lines.length).toBeGreaterThanOrEqual(9);
  }, 8000);
});

// ---------------------------------------------------------------------------
// Workspace path segments (issue #40)
//
// The server assigns slugs (src/lib/slug.ts) and the runner validates each
// path segment against WORKSPACE_SEGMENT_RE before mkdir. Two bundles (TS app
// vs plain-JS runner), so lock them together: every slug the server can
// produce is either "" (rejected at creation as an invalid name) or accepted
// by the runner verbatim — the server can never mint a segment the runner
// refuses.
// ---------------------------------------------------------------------------
describe("slugify output is always a valid workspace segment", () => {
  const NASTY_NAMES = [
    "Dev Agent",
    "Dev_Agent",
    "  My  Project!! ",
    "日本語",
    "🚀 Launch Crew 🚀",
    "../../../etc/passwd",
    "..",
    "a/b/c",
    "C:\\Users\\agent",
    "UPPER CASE NAME",
    "tabs\tand\nnewlines",
    "dots.dashes-and---runs",
    "café au lait",
    "name (copy) #2!",
    "-leading-and-trailing-",
    "null\u0000byte",
    "zwsp\u200bname",
    "",
    "   ",
    "🚀🚀",
  ];

  it("every non-empty slug matches WORKSPACE_SEGMENT_RE", () => {
    for (const name of NASTY_NAMES) {
      const slug = slugify(name);
      if (slug !== "") {
        expect(slug, `slugify(${JSON.stringify(name)})`).toMatch(WORKSPACE_SEGMENT_RE);
      }
    }
  });

  it("the battery exercises both outcomes (guard against a vacuous loop)", () => {
    const slugs = NASTY_NAMES.map(slugify);
    expect(slugs).toContain("");
    expect(slugs).toContain("dev-agent");
  });
});

describe("ensureWorkingDir", () => {
  const prevHome = process.env.HARBOUR_HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-ws-test-"));
    process.env.HARBOUR_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HARBOUR_HOME;
    else process.env.HARBOUR_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates the nested project/agent directory under HARBOUR_HOME", () => {
    const dir = ensureWorkingDir(["website", "dev-agent"]);
    expect(dir).toBe(path.join(home, "workspaces", "website", "dev-agent"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("supports the legacy single-segment (flat) layout", () => {
    const dir = ensureWorkingDir(["dev-agent"]);
    expect(dir).toBe(path.join(home, "workspaces", "dev-agent"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses invalid segments instead of transforming them", () => {
    expect(() => ensureWorkingDir([".."])).toThrow(/Invalid workspace path segment/);
    expect(() => ensureWorkingDir(["a/b"])).toThrow(/Invalid workspace path segment/);
    expect(() => ensureWorkingDir([""])).toThrow(/Invalid workspace path segment/);
    expect(() => ensureWorkingDir(["UPPER"])).toThrow(/Invalid workspace path segment/);
    // One bad segment poisons the whole path, wherever it sits.
    expect(() => ensureWorkingDir(["website", "..", "dev-agent"])).toThrow(
      /Invalid workspace path segment/,
    );
    // Validation happens before mkdir — a refused run creates nothing.
    expect(fs.existsSync(path.join(home, "workspaces"))).toBe(false);
  });

  it("rejects an empty segment list", () => {
    expect(() => ensureWorkingDir([])).toThrow(/No workspace path segments/);
  });
});

// Honest CLI detection: the runner advertises a CLI only when it's actually on
// PATH — no bare-name fallback — so it never claims work it can't execute and
// the absent-capability surface stays accurate.
describe("detectCapabilities — honest CLI detection", () => {
  const ORIGINAL_PATH = process.env.PATH;

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
    resetBinaryCache();
  });

  it("does not advertise CLIs that are not on PATH", () => {
    // An empty temp dir as the entire PATH holds neither claude nor codex
    // (system dirs can't be trusted — dev machines have the CLIs installed).
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hb-nopath-"));
    try {
      process.env.PATH = empty;
      resetBinaryCache();
      const caps = detectCapabilities();
      expect(caps.clis).toEqual([]);
      expect(caps.kinds).toEqual(["workflow"]); // no "agent" kind without a CLI
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("advertises a CLI that IS on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cli-"));
    try {
      const fake = path.join(dir, "codex");
      fs.writeFileSync(fake, "#!/bin/sh\necho fake\n");
      fs.chmodSync(fake, 0o755);
      process.env.PATH = `${dir}:/usr/bin:/bin`;
      resetBinaryCache();
      const caps = detectCapabilities();
      expect(caps.clis).toContain("codex");
      expect(caps.kinds).toContain("agent");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveBinary returns null for a missing binary (no bare-name fallback)", () => {
    process.env.PATH = "/usr/bin:/bin";
    resetBinaryCache();
    expect(resolveBinary("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
