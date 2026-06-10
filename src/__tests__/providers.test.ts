import { describe, expect, it } from "vitest";
import { getProvider, runCliTool } from "../../bin/lib/providers.mjs";

// These tests assert the argv shape produced by each provider's buildCommand.
// They guard against silent flag drift in the upstream CLIs (issue #24 was
// caused by Gemini 0.40 dropping --thinking and Codex 0.128 dropping
// --reasoning-effort). When upgrading a CLI, update both the provider and
// these expectations together so the change is visible in review.

const CWD = "/tmp/test-workspace";
const PROMPT = "do the thing";

describe("claude provider", () => {
  const claude = getProvider("claude");

  it("builds a basic command without thinking", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "abc-123", true, null);
    expect(cmd.cwd).toBe(CWD);
    expect(cmd.args).toContain("-p");
    expect(cmd.args).toContain(PROMPT);
    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("sonnet");
    expect(cmd.args).not.toContain("--effort");
  });

  it("passes thinking via --effort", () => {
    const cmd = claude.buildCommand(PROMPT, "sonnet", CWD, "abc-123", true, "high");
    expect(cmd.args).toContain("--effort");
    const effortIdx = cmd.args.indexOf("--effort");
    expect(cmd.args[effortIdx + 1]).toBe("high");
  });

  it("uses --session-id for new sessions and --resume for existing", () => {
    const fresh = claude.buildCommand(PROMPT, "sonnet", CWD, "uuid-1", true, null);
    expect(fresh.args).toContain("--session-id");
    expect(fresh.args).not.toContain("--resume");

    const resume = claude.buildCommand(PROMPT, "sonnet", CWD, "uuid-1", false, null);
    expect(resume.args).toContain("--resume");
    expect(resume.args).not.toContain("--session-id");
  });
});

describe("codex provider (issue #24)", () => {
  const codex = getProvider("codex");

  it("does NOT use the removed --reasoning-effort flag", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, "low");
    expect(cmd.args).not.toContain("--reasoning-effort");
  });

  it("passes thinking via -c model_reasoning_effort=<level> on a fresh session", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, "high");
    expect(cmd.args).toContain("-c");
    expect(cmd.args).toContain("model_reasoning_effort=high");
    // The -c and its value must be adjacent
    const cIdx = cmd.args.indexOf("-c");
    expect(cmd.args[cIdx + 1]).toBe("model_reasoning_effort=high");
  });

  it("passes thinking via -c on a resumed session", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, "session-uuid", false, "medium");
    expect(cmd.args[0]).toBe("exec");
    expect(cmd.args[1]).toBe("resume");
    expect(cmd.args).toContain("-c");
    expect(cmd.args).toContain("model_reasoning_effort=medium");
    expect(cmd.args).not.toContain("--reasoning-effort");
    // Session id and prompt must be the trailing positional args
    expect(cmd.args[cmd.args.length - 2]).toBe("session-uuid");
    expect(cmd.args[cmd.args.length - 1]).toBe(PROMPT);
  });

  it("omits -c when no thinking value is set", () => {
    const cmd = codex.buildCommand(PROMPT, "gpt-5", CWD, null, true, null);
    expect(cmd.args).not.toContain("-c");
  });
});

describe("gemini provider (issue #24)", () => {
  const gemini = getProvider("gemini");

  it("does NOT use the removed --thinking flag", () => {
    const cmd = gemini.buildCommand(PROMPT, "gemini-2.5-pro", CWD, null, true, "low");
    expect(cmd.args).not.toContain("--thinking");
  });

  it("includes --skip-trust for headless mode in non-trusted workspaces", () => {
    const cmd = gemini.buildCommand(PROMPT, "gemini-2.5-pro", CWD, null, true, null);
    expect(cmd.args).toContain("--skip-trust");
  });

  it("ignores any thinking value the caller passes", () => {
    // Existing agents may have a stale `thinking` saved in the DB; the runner
    // still passes it to buildCommand. The provider must drop it silently.
    const cmd = gemini.buildCommand(PROMPT, "gemini-2.5-pro", CWD, null, true, "high");
    expect(cmd.args).not.toContain("--thinking");
    expect(cmd.args).not.toContain("high");
  });

  it("passes the prompt and model", () => {
    const cmd = gemini.buildCommand(PROMPT, "gemini-2.5-pro", CWD, null, true, null);
    expect(cmd.args).toContain("--prompt");
    const pIdx = cmd.args.indexOf("--prompt");
    expect(cmd.args[pIdx + 1]).toBe(PROMPT);
    expect(cmd.args).toContain("-m");
    expect(cmd.args).toContain("gemini-2.5-pro");
    expect(cmd.args).toContain("--yolo");
    expect(cmd.args).toContain("-o");
    expect(cmd.args).toContain("stream-json");
  });

  it("passes --resume for existing sessions", () => {
    const cmd = gemini.buildCommand(PROMPT, "gemini-2.5-pro", CWD, "session-uuid", false, null);
    expect(cmd.args).toContain("--resume");
    const rIdx = cmd.args.indexOf("--resume");
    expect(cmd.args[rIdx + 1]).toBe("session-uuid");
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
