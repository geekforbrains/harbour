import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProvider, RunCliToolOptions } from "@/lib/captain/providers";

// Captain session handling: only providers that accept a caller-chosen session
// ID (claude's --session-id) get one pre-generated for a new session. Codex and
// gemini mint their own ID on first run — handing them a made-up UUID sends
// buildCommand down the resume path, which fails on a session that never
// existed (silent empty response, issue observed with codex as Captain).

vi.mock("@/lib/captain/providers", () => ({
  getProvider: vi.fn(),
  runCliTool: vi.fn(),
}));
vi.mock("@/lib/db/captain", () => ({
  addCaptainOutput: vi.fn(),
  listCaptainOutput: vi.fn(() => []),
  updateConversation: vi.fn(),
  updateMessageContent: vi.fn(),
}));
vi.mock("@/lib/captain/workspace", () => ({ setupWorkspace: vi.fn() }));
vi.mock("@/lib/paths", () => ({
  ensureDir: vi.fn(),
  harbourHome: () => "/tmp/harbour-test",
}));

import { isRunning, spawn } from "@/lib/captain/process-manager";
import { getProvider, runCliTool } from "@/lib/captain/providers";
import { addCaptainOutput, updateConversation } from "@/lib/db/captain";

function makeProvider(overrides: Partial<CliProvider> = {}): CliProvider {
  return {
    buildCommand: vi.fn((_prompt, _model, cwd) => ({ binary: "fake", args: [], cwd })),
    parseLine: vi.fn(() => ({ events: [] })),
    ...overrides,
  };
}

function mockCliExit(result: { code: number; stderr?: string; aborted?: boolean }) {
  vi.mocked(runCliTool).mockResolvedValue({
    code: result.code,
    stdout: "",
    stderr: result.stderr ?? "",
    aborted: result.aborted ?? false,
  });
}

function spawnOpts(overrides: Partial<Parameters<typeof spawn>[0]> = {}) {
  return {
    conversationId: "conv-1",
    messageId: "msg-1",
    prompt: "hello",
    cli: "codex",
    model: null,
    thinking: null,
    sessionId: null,
    isNewSession: true,
    cwd: "/tmp/harbour-test/captain",
    ...overrides,
  };
}

async function settled(conversationId: string) {
  await vi.waitFor(() => expect(isRunning(conversationId)).toBe(false));
}

describe("captain spawn session handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes null sessionId to buildCommand for a new session when the provider cannot pre-generate (codex/gemini)", async () => {
    const provider = makeProvider();
    vi.mocked(getProvider).mockResolvedValue(provider);
    mockCliExit({ code: 0 });

    await spawn(spawnOpts());
    await settled("conv-1");

    expect(provider.buildCommand).toHaveBeenCalledWith(
      "hello",
      null,
      expect.any(String),
      null,
      true,
      null,
    );
  });

  it("pre-generates a session ID for a new session when the provider supports it (claude)", async () => {
    const provider = makeProvider({ generateSessionId: () => "generated-id" });
    vi.mocked(getProvider).mockResolvedValue(provider);
    mockCliExit({ code: 0 });

    await spawn(spawnOpts({ cli: "claude" }));
    await settled("conv-1");

    expect(provider.buildCommand).toHaveBeenCalledWith(
      "hello",
      null,
      expect.any(String),
      "generated-id",
      true,
      null,
    );
    expect(updateConversation).toHaveBeenCalledWith("conv-1", { session_id: "generated-id" });
  });

  it("persists the CLI-minted session ID captured from output on a new codex-style session", async () => {
    const provider = makeProvider({
      parseLine: vi.fn(() => ({ events: [], sessionId: "thread-from-cli" })),
    });
    vi.mocked(getProvider).mockResolvedValue(provider);
    vi.mocked(runCliTool).mockImplementation(
      async (_binary, _args, _cwd, options?: RunCliToolOptions) => {
        options?.onLine?.('{"type":"thread.started"}');
        return { code: 0, stdout: "", stderr: "", aborted: false };
      },
    );

    await spawn(spawnOpts());
    await settled("conv-1");

    expect(updateConversation).toHaveBeenCalledWith("conv-1", { session_id: "thread-from-cli" });
  });

  it("passes the stored session ID through for an existing session", async () => {
    const provider = makeProvider();
    vi.mocked(getProvider).mockResolvedValue(provider);
    mockCliExit({ code: 0 });

    await spawn(spawnOpts({ sessionId: "existing-id", isNewSession: false }));
    await settled("conv-1");

    expect(provider.buildCommand).toHaveBeenCalledWith(
      "hello",
      null,
      expect.any(String),
      "existing-id",
      false,
      null,
    );
  });

  it("writes an error event when the CLI exits non-zero", async () => {
    const provider = makeProvider();
    vi.mocked(getProvider).mockResolvedValue(provider);
    mockCliExit({ code: 1, stderr: "Error: thread/resume failed: no rollout found" });

    await spawn(spawnOpts());
    await settled("conv-1");

    expect(addCaptainOutput).toHaveBeenCalledWith("conv-1", "msg-1", [
      {
        event_type: "error",
        content: "Error: thread/resume failed: no rollout found",
        tool_name: null,
      },
    ]);
  });

  it("does not write an error event when the process was aborted by the user", async () => {
    const provider = makeProvider();
    vi.mocked(getProvider).mockResolvedValue(provider);
    mockCliExit({ code: 143, aborted: true });

    await spawn(spawnOpts());
    await settled("conv-1");

    expect(addCaptainOutput).not.toHaveBeenCalled();
  });
});
