import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  buildLlmConnectionInput,
  buildLlmConnectionUpdateInput,
  createLlmConnectionDraft,
  createLlmConnectionDraftFromConnection,
  modelErrorForProvider,
  modelPlaceholderForProvider,
  modelSuggestionsForProvider,
  validateLlmConnectionDraft,
} from "@/components/app/llm-connection-form";
import { qk } from "@/lib/api/keys";
import { CLI_CONFIG, mergeSupportedCliTools, validateThinking } from "@/lib/cli-config";
import { invalidateLlmConnectionCaches } from "@/lib/hooks/use-llm-connections";

describe("LLM connection form helpers", () => {
  it("builds an OpenAI connection with an existing Secret", () => {
    const draft = {
      ...createLlmConnectionDraft("openai"),
      name: "OpenAI production",
      credentialMode: "existing" as const,
      credentialId: "secret-1",
    };

    expect(buildLlmConnectionInput(draft)).toEqual({
      name: "OpenAI production",
      kind: "openai",
      provider_id: "openai",
      protocol: "native",
      credential_id: "secret-1",
    });
  });

  it("uses runner-local defaults for Ollama and omits credentials", () => {
    const draft = {
      ...createLlmConnectionDraft("ollama"),
      name: "Local Ollama",
    };

    expect(buildLlmConnectionInput(draft)).toEqual({
      name: "Local Ollama",
      kind: "ollama",
      provider_id: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
      protocol: "chat-completions",
    });

    expect(buildLlmConnectionUpdateInput(draft)).toEqual({
      name: "Local Ollama",
      kind: "ollama",
      provider_id: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
      protocol: "chat-completions",
      credential_id: null,
    });
  });

  it("clears a stale endpoint when updating to a native provider", () => {
    const draft = {
      ...createLlmConnectionDraft("openai"),
      name: "OpenAI",
      credentialMode: "existing" as const,
      credentialId: "secret-1",
    };

    expect(buildLlmConnectionUpdateInput(draft).base_url).toBeNull();
  });

  it("builds a custom provider with a transactionally-created Secret", () => {
    const draft = {
      ...createLlmConnectionDraft("openai-compatible"),
      name: "Lab gateway",
      providerId: "lab",
      baseUrl: "https://llm.example.test/v1",
      credentialMode: "new" as const,
      credentialName: "LAB_LLM_API_KEY",
      credentialValue: "secret-value",
    };

    expect(buildLlmConnectionInput(draft)).toEqual({
      name: "Lab gateway",
      kind: "openai-compatible",
      provider_id: "lab",
      base_url: "https://llm.example.test/v1",
      protocol: "chat-completions",
      credential: { name: "LAB_LLM_API_KEY", value: "secret-value" },
    });
  });

  it("keeps a keyless OpenAI-compatible connection keyless when editing", () => {
    const draft = createLlmConnectionDraftFromConnection({
      name: "Keyless gateway",
      kind: "openai-compatible",
      provider_id: "lab",
      base_url: "http://model-gateway.internal/v1",
      protocol: "responses",
      credential: null,
    });

    expect(draft.credentialMode).toBe("none");
    expect(buildLlmConnectionUpdateInput(draft).credential_id).toBeNull();
  });
});

describe("OpenCode model fields", () => {
  it("requires canonical provider/model identifiers", () => {
    expect(modelErrorForProvider("openai", "gpt-5.4")).toMatch(/provider\/model/);
    expect(modelErrorForProvider("openai", "anthropic/claude-sonnet-4-6")).toMatch(
      /must use the openai provider/,
    );
    expect(modelErrorForProvider("openrouter", "openrouter/anthropic/claude-sonnet-4")).toBeNull();
  });

  it("uses the selected provider in the manual-entry placeholder", () => {
    expect(modelPlaceholderForProvider("ollama")).toBe("ollama/model-id");
    expect(modelSuggestionsForProvider("openai")).toEqual([
      "openai/gpt-5.6",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);
    expect(modelSuggestionsForProvider("openrouter")).toContain("openrouter/openai/gpt-5.6-terra");
    expect(modelSuggestionsForProvider("openrouter")).not.toContain("openrouter/openai/gpt-5.6");
  });

  it("rejects credentials embedded in a runner endpoint URL", () => {
    const draft = {
      ...createLlmConnectionDraft("openai-compatible"),
      name: "Gateway",
      providerId: "gateway",
      baseUrl: "https://user:password@example.test/v1",
      credentialMode: "none" as const,
    };

    expect(validateLlmConnectionDraft(draft)).toMatch(/must not contain credentials/);
  });

  it("accepts safe provider-specific variants and rejects unsafe tokens", () => {
    expect(validateThinking("opencode", "fast-preview")).toBeNull();
    expect(validateThinking("opencode", "a".repeat(65))).toBeTruthy();
    expect(validateThinking("opencode", "high; rm -rf")).toBeTruthy();
    expect(CLI_CONFIG.opencode.thinkingOptions).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("CLI discovery", () => {
  it("keeps every supported CLI selectable when the server cannot detect it locally", () => {
    const tools = mergeSupportedCliTools([
      { id: "claude", name: "Claude", installed: true, version: "1.0.0" },
    ]);

    expect(tools).toEqual([
      { id: "claude", name: "Claude", installed: true, version: "1.0.0" },
      { id: "codex", name: "Codex", installed: false },
      { id: "opencode", name: "OpenCode", installed: false },
    ]);
  });
});

describe("LLM connection cache invalidation", () => {
  it("refreshes Secret pickers after an inline Secret is created", async () => {
    const queryClient = new QueryClient();
    let finishSecretRefresh = () => {};
    const secretRefresh = new Promise<void>((resolve) => {
      finishSecretRefresh = resolve;
    });
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation((filters) =>
        filters?.queryKey === qk.envVars.all ? secretRefresh : Promise.resolve(),
      );

    let settled = false;
    const pending = invalidateLlmConnectionCaches(queryClient, {
      connectionId: "connection-1",
      refreshAgents: true,
      input: {
        credential: { name: "OPENAI_API_KEY", value: "secret-value" },
      },
    });
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishSecretRefresh();
    await pending;

    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.llmConnections.all });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.llmConnections.detail("connection-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.agents.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.envVars.all });
    expect(settled).toBe(true);
  });

  it("does not refetch Secrets when a mutation did not create one", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    await invalidateLlmConnectionCaches(queryClient, { input: { credential_id: "secret-1" } });

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.envVars.all });
  });
});
