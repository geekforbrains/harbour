import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSessionCompatible, loadSessions, saveSessions } from "../../bin/lib/config.mjs";
import {
  buildChildEnvironment,
  buildOpenCodeRuntime,
  getProvider,
  isOpenCodeVersionSupported,
  redactSecrets,
  runCliTool,
  sanitizeProviderEvent,
  sanitizeProviderText,
  sanitizeThinking,
} from "../../bin/lib/providers.mjs";
import { buildProviderCommand, splitPrivateRuntime } from "../../bin/lib/runner.mjs";

const CWD = "/tmp/opencode-workspace";
const PROMPT = "do the thing";

function builtinRuntime(overrides: Record<string, unknown> = {}) {
  return buildOpenCodeRuntime({
    model: "openai/gpt-5",
    variant: "high",
    provider: {
      id: "connection-1",
      kind: "openai",
      provider_id: "openai",
      base_url: null,
      protocol: "native",
      credential_id: "secret-1",
    },
    apiKey: "sk-test-secret",
    harbourHome: "/tmp/harbour-test",
    ...overrides,
  });
}

describe("OpenCode command", () => {
  const opencode = getProvider("opencode");

  it("builds the documented direct JSONL command", () => {
    const runtime = builtinRuntime();
    const cmd = opencode.buildCommand(
      PROMPT,
      "openai/gpt-5",
      CWD,
      "session-1",
      false,
      "high",
      runtime,
    );

    expect(cmd.args).toEqual([
      "run",
      "--pure",
      "--auto",
      "--format",
      "json",
      "--model",
      "openai/gpt-5",
      "--dir",
      CWD,
      "--session",
      "session-1",
      "--variant",
      "high",
      PROMPT,
    ]);
    expect(cmd.cwd).toBe(runtime.launchDir);
    expect(cmd.workspaceDir).toBe(CWD);
  });

  it("omits resume and variant flags for a fresh default-variant turn", () => {
    const runtime = builtinRuntime({ variant: null });
    const cmd = opencode.buildCommand(PROMPT, "openai/gpt-5", CWD, null, true, null, runtime);

    expect(cmd.args).not.toContain("--session");
    expect(cmd.args).not.toContain("--variant");
  });

  it("keeps runner orchestration arguments aligned with the provider contract", () => {
    const received: unknown[] = [];
    const provider = {
      buildCommand(...args: unknown[]) {
        received.push(...args);
        return { binary: "/bin/true", args: [], cwd: CWD };
      },
    };
    const runtime = { launchDir: "/tmp/opencode-runtime" };

    buildProviderCommand({
      provider,
      prompt: PROMPT,
      model: "openai/gpt-5",
      workingDir: CWD,
      sessionId: "session-1",
      isNewSession: false,
      thinking: "high",
      providerRuntime: runtime,
    });

    expect(received).toEqual([PROMPT, "openai/gpt-5", CWD, "session-1", false, "high", runtime]);
  });

  it("requires a version that can disable repository-owned configuration", () => {
    expect(isOpenCodeVersionSupported("1.1.29")).toBe(false);
    expect(isOpenCodeVersionSupported("1.17.11")).toBe(false);
    expect(isOpenCodeVersionSupported("1.17.12")).toBe(true);
    expect(isOpenCodeVersionSupported("opencode 1.18.4")).toBe(true);
    expect(isOpenCodeVersionSupported("not-a-version")).toBe(false);
  });
});

describe("OpenCode runtime config", () => {
  it("uses one provider, documented env substitution, and hardened runtime settings", () => {
    const runtime = builtinRuntime();
    const config = JSON.parse(runtime.controlEnv.OPENCODE_CONFIG_CONTENT);

    expect(config.enabled_providers).toEqual(["openai"]);
    expect(config.share).toBe("disabled");
    expect(config.autoupdate).toBe(false);
    expect(config.permission).toMatchObject({
      external_directory: "deny",
      question: "deny",
    });
    expect(config.provider.openai.options.apiKey).toBe("{env:HARBOUR_OPENCODE_API_KEY}");
    expect(runtime.controlEnv.HARBOUR_OPENCODE_API_KEY).toBe("sk-test-secret");
    expect(runtime.controlEnv.OPENCODE_AUTH_CONTENT).toBe("{}");
    expect(runtime.controlEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(runtime.controlEnv.OPENCODE_CONFIG_CONTENT).not.toContain("sk-test-secret");
    expect(runtime.controlEnv).not.toHaveProperty("XDG_CONFIG_HOME");
    expect(runtime.isolatedEnv).toBe(true);
  });

  it("derives, rather than accepting, the SDK package for compatible providers", () => {
    const chat = buildOpenCodeRuntime({
      model: "local/qwen3:8b",
      variant: null,
      provider: {
        id: "connection-2",
        kind: "openai-compatible",
        provider_id: "local",
        base_url: "http://127.0.0.1:8080/v1",
        protocol: "chat-completions",
      },
      apiKey: "local-secret",
      harbourHome: "/tmp/harbour-test",
    });
    const responses = buildOpenCodeRuntime({
      model: "proxy/gpt-5",
      variant: null,
      provider: {
        id: "connection-3",
        kind: "openai-compatible",
        provider_id: "proxy",
        base_url: "https://llm.example/v1",
        protocol: "responses",
      },
      apiKey: "proxy-secret",
      harbourHome: "/tmp/harbour-test",
    });

    expect(JSON.parse(chat.controlEnv.OPENCODE_CONFIG_CONTENT).provider.local.npm).toBe(
      "@ai-sdk/openai-compatible",
    );
    expect(JSON.parse(responses.controlEnv.OPENCODE_CONFIG_CONTENT).provider.proxy.npm).toBe(
      "@ai-sdk/openai",
    );
  });

  it("builds keyless Ollama config with an explicit selected model", () => {
    const runtime = buildOpenCodeRuntime({
      model: "ollama/qwen3:8b",
      variant: null,
      provider: {
        id: "connection-4",
        kind: "ollama",
        provider_id: "ollama",
        base_url: null,
        protocol: "chat-completions",
      },
      apiKey: null,
      harbourHome: "/tmp/harbour-test",
    });
    const config = JSON.parse(runtime.controlEnv.OPENCODE_CONFIG_CONTENT);

    expect(config.provider.ollama.options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(config.provider.ollama.models).toEqual({ "qwen3:8b": { name: "qwen3:8b" } });
    expect(config.provider.ollama.options).not.toHaveProperty("apiKey");
    expect(runtime.controlEnv).not.toHaveProperty("HARBOUR_OPENCODE_API_KEY");
  });

  it("rejects a model whose provider prefix does not match the selected connection", () => {
    expect(() => builtinRuntime({ model: "anthropic/claude-sonnet-4" })).toThrow(
      /must use provider "openai"/,
    );
  });

  it("rejects provider base URLs containing a query string", () => {
    expect(() =>
      buildOpenCodeRuntime({
        model: "proxy/gpt-5",
        variant: null,
        provider: {
          id: "connection-query",
          kind: "openai-compatible",
          provider_id: "proxy",
          base_url: "https://llm.example/v1?api_key=must-not-live-in-metadata",
          protocol: "responses",
        },
        apiKey: null,
        harbourHome: "/tmp/harbour-test",
      }),
    ).toThrow(/query string/);
  });

  it("fingerprints only non-secret resume configuration", () => {
    const first = builtinRuntime({ apiKey: "first-secret" });
    const rotated = builtinRuntime({ apiKey: "rotated-secret" });
    const changedModel = builtinRuntime({ model: "openai/gpt-5-mini" });
    const changedCredential = builtinRuntime({
      provider: {
        id: "connection-1",
        kind: "openai",
        provider_id: "openai",
        base_url: null,
        protocol: "native",
        credential_id: "secret-2",
      },
    });

    expect(first.configFingerprint).toBe(rotated.configFingerprint);
    expect(first.configFingerprint).not.toBe(changedModel.configFingerprint);
    expect(first.configFingerprint).not.toBe(changedCredential.configFingerprint);
    expect(first.configFingerprint).not.toContain("secret");
  });
});

describe("OpenCode JSONL parser", () => {
  it("normalizes session, text, and reasoning events", () => {
    const parser = getProvider("opencode").createParser();
    const text = parser.parseLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses-1",
        part: { id: "part-1", type: "text", text: "Hello" },
      }),
    );
    const reasoning = parser.parseLine(
      JSON.stringify({
        type: "reasoning",
        sessionID: "ses-1",
        part: { id: "part-2", type: "reasoning", text: "Thinking" },
      }),
    );

    expect(text).toEqual({
      events: [{ event_type: "text_delta", content: "Hello" }],
      sessionId: "ses-1",
    });
    expect(reasoning.events).toEqual([{ event_type: "thinking", content: "Thinking" }]);
  });

  it("synthesizes a start and end when only a completed tool event arrives", () => {
    const parser = getProvider("opencode").createParser();
    const parsed = parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses-1",
        part: {
          id: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "/tmp/workspace",
          },
        },
      }),
    );

    expect(parsed.events).toEqual([
      { event_type: "tool_start", content: "pwd", tool_name: "bash" },
      { event_type: "tool_end", content: "/tmp/workspace", tool_name: "bash" },
    ]);
  });

  it("does not duplicate tool starts across running and completed updates", () => {
    const parser = getProvider("opencode").createParser();
    const running = parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "call-1",
          tool: "read",
          state: { status: "running", input: { filePath: "/tmp/a" } },
        },
      }),
    );
    const completed = parser.parseLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "call-1",
          tool: "read",
          state: { status: "completed", input: { filePath: "/tmp/a" }, output: "ok" },
        },
      }),
    );

    expect(running.events).toHaveLength(1);
    expect(running.events[0].event_type).toBe("tool_start");
    expect(completed.events).toEqual([
      { event_type: "tool_end", content: "ok", tool_name: "read" },
    ]);
  });

  it("maps step usage to a result event", () => {
    const parsed = getProvider("opencode")
      .createParser()
      .parseLine(
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses-1",
          part: { tokens: { input: 10, output: 4, reasoning: 2 }, cost: 0.000123 },
        }),
      );

    expect(parsed.events).toEqual([
      { event_type: "result", content: "Tokens: 10 in / 4 out / 2 reasoning · Cost: $0.000123" },
    ]);
  });

  it("allowlists error fields and drops provider response headers and bodies", () => {
    const parsed = getProvider("opencode")
      .createParser()
      .parseLine(
        JSON.stringify({
          type: "error",
          sessionID: "ses-1",
          error: {
            name: "APIError",
            data: {
              message: "Unauthorized",
              statusCode: 401,
              providerID: "openai",
              modelID: "gpt-5",
              responseHeaders: { authorization: "Bearer should-not-leak" },
              responseBody: "raw-body-should-not-leak",
            },
          },
        }),
      );
    const content = parsed.events[0].content;

    expect(parsed.events[0].event_type).toBe("error");
    expect(content).toContain("APIError");
    expect(content).toContain("Unauthorized");
    expect(content).toContain("401");
    expect(content).not.toContain("should-not-leak");
  });

  it("uses the last text event as the activity summary", () => {
    const stdout = [
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { text: "Working" } }),
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { text: "Finished" } }),
    ].join("\n");

    expect(getProvider("opencode").parseResult(stdout)).toEqual({
      content: "Finished",
      sessionId: "ses-1",
    });
  });
});

describe("OpenCode secret and environment isolation", () => {
  const originalHostSecret = process.env.HOST_ONLY_SECRET;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalHostSecret === undefined) delete process.env.HOST_ONLY_SECRET;
    else process.env.HOST_ONLY_SECRET = originalHostSecret;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  });

  it("redacts every occurrence, preferring longer overlapping values", () => {
    expect(redactSecrets("token=abc123 and abc", ["abc", "abc123", ""])).toBe(
      "token=[REDACTED] and [REDACTED]",
    );
  });

  it("redacts very short secrets only as standalone tokens", () => {
    expect(redactSecrets("version=1.18.4 model=xlarge token=x attempt=1", ["x", "1"])).toBe(
      "version=1.18.4 model=xlarge token=[REDACTED] attempt=[REDACTED]",
    );
  });

  it("caps large tool output before it can be persisted", () => {
    const event = sanitizeProviderEvent(
      { event_type: "tool_end", content: "x".repeat(50_000), tool_name: "read" },
      [],
    );

    expect(event.content.length).toBeLessThanOrEqual(12_000);
    expect(event.content).toContain("[truncated");
  });

  it("redacts and caps final provider output before activity persistence", () => {
    const output = sanitizeProviderText(`secret-${"x".repeat(50_000)}`, ["secret"], 2_000);

    expect(output.length).toBeLessThanOrEqual(2_000);
    expect(output).not.toContain("secret");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[truncated");
  });

  it("preserves host XDG locations while refusing job-level overrides", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/normal-host-xdg";
    const env = buildChildEnvironment({
      isolatedEnv: true,
      extraEnv: { XDG_CONFIG_HOME: "/tmp/job-override" },
    });

    expect(env.XDG_CONFIG_HOME).toBe("/tmp/normal-host-xdg");
  });

  it("does not inherit arbitrary host secrets and gives control vars final precedence", async () => {
    process.env.HOST_ONLY_SECRET = "host-secret";
    const script =
      "process.stdout.write(JSON.stringify({host:process.env.HOST_ONLY_SECRET,job:process.env.JOB_VISIBLE,auth:process.env.OPENCODE_AUTH_CONTENT}))";
    const result = await runCliTool(process.execPath, ["-e", script], process.cwd(), {
      isolatedEnv: true,
      extraEnv: { JOB_VISIBLE: "yes", OPENCODE_AUTH_CONTENT: "attacker-value" },
      controlEnv: { OPENCODE_AUTH_CONTENT: "{}" },
    });

    expect(JSON.parse(result.stdout)).toEqual({ job: "yes", auth: "{}" });
  });

  it("passes arbitrary validated OpenCode variants and rejects unsafe ones", () => {
    expect(sanitizeThinking("opencode", "_custom.fast")).toEqual({
      thinking: "_custom.fast",
      dropped: null,
    });
    expect(sanitizeThinking("opencode", "bad variant")).toEqual({
      thinking: null,
      dropped: "bad variant",
    });
  });
});

describe("OpenCode private runtime and session compatibility", () => {
  it("extracts the key without mutating or forwarding runtime metadata", () => {
    const input = {
      run: { id: "run-1" },
      agent: { cli: "opencode" },
      runtime: { llm: { api_key: "private-key" } },
    };
    const split = splitPrivateRuntime(input);

    expect(split.llmApiKey).toBe("private-key");
    expect(split.payload).not.toHaveProperty("runtime");
    expect(input.runtime.llm.api_key).toBe("private-key");
  });

  it("resets OpenCode resumes when the non-secret config fingerprint changes", () => {
    expect(
      isSessionCompatible(
        { sessionId: "ses-1", cli: "opencode", configFingerprint: "old" },
        { cli: "opencode", configFingerprint: "new", requireFingerprint: true },
      ),
    ).toBe(false);
    expect(
      isSessionCompatible(
        { sessionId: "ses-1", cli: "opencode", configFingerprint: "same" },
        { cli: "opencode", configFingerprint: "same", requireFingerprint: true },
      ),
    ).toBe(true);
  });

  it("keeps legacy Claude/Codex session records compatible", () => {
    expect(
      isSessionCompatible(
        { sessionId: "ses-1", cli: "claude", cwd: "/tmp/ws" },
        { cli: "claude", configFingerprint: null, requireFingerprint: false },
      ),
    ).toBe(true);
  });

  it("persists the non-secret fingerprint in the existing session file", () => {
    const originalHome = process.env.HARBOUR_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-opencode-session-"));
    process.env.HARBOUR_HOME = home;
    try {
      saveSessions({
        "run-1": {
          sessionId: "ses-1",
          cli: "opencode",
          cwd: "/tmp/ws",
          configFingerprint: "sha256:test",
        },
      });
      expect(loadSessions()["run-1"].configFingerprint).toBe("sha256:test");
    } finally {
      if (originalHome === undefined) delete process.env.HARBOUR_HOME;
      else process.env.HARBOUR_HOME = originalHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
