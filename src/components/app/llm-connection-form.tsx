"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EnvVar } from "@/lib/hooks/use-env-vars";
import type {
  LlmConnection,
  LlmConnectionInput,
  LlmConnectionKind,
  LlmProtocol,
} from "@/lib/hooks/use-llm-connections";
import { SELECT_CLASS } from "./model-thinking-select";

export type CredentialMode = "none" | "existing" | "new";

export type LlmConnectionDraft = {
  name: string;
  kind: LlmConnectionKind;
  providerId: string;
  baseUrl: string;
  protocol: LlmProtocol;
  credentialMode: CredentialMode;
  credentialId: string;
  credentialName: string;
  credentialValue: string;
};

const PRESETS: Record<
  LlmConnectionKind,
  {
    label: string;
    providerId: string;
    baseUrl: string;
    protocol: LlmProtocol;
    credentialName: string;
    credentialMode: CredentialMode;
  }
> = {
  openai: {
    label: "OpenAI",
    providerId: "openai",
    baseUrl: "",
    protocol: "native",
    credentialName: "OPENAI_API_KEY",
    credentialMode: "new",
  },
  anthropic: {
    label: "Anthropic",
    providerId: "anthropic",
    baseUrl: "",
    protocol: "native",
    credentialName: "ANTHROPIC_API_KEY",
    credentialMode: "new",
  },
  openrouter: {
    label: "OpenRouter",
    providerId: "openrouter",
    baseUrl: "",
    protocol: "native",
    credentialName: "OPENROUTER_API_KEY",
    credentialMode: "new",
  },
  ollama: {
    label: "Ollama",
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "chat-completions",
    credentialName: "",
    credentialMode: "none",
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    providerId: "custom",
    baseUrl: "",
    protocol: "chat-completions",
    credentialName: "LLM_API_KEY",
    credentialMode: "new",
  },
};

export function createLlmConnectionDraft(kind: LlmConnectionKind = "openai"): LlmConnectionDraft {
  const preset = PRESETS[kind];
  return {
    name: "",
    kind,
    providerId: preset.providerId,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    credentialMode: preset.credentialMode,
    credentialId: "",
    credentialName: preset.credentialName,
    credentialValue: "",
  };
}

export function createLlmConnectionDraftFromConnection(
  connection: Pick<
    LlmConnection,
    "name" | "kind" | "provider_id" | "base_url" | "protocol" | "credential"
  >,
): LlmConnectionDraft {
  const preset = createLlmConnectionDraft(connection.kind);
  const canBeKeyless = connection.kind === "ollama" || connection.kind === "openai-compatible";
  return {
    ...preset,
    name: connection.name,
    providerId: connection.provider_id,
    baseUrl: connection.base_url || "",
    protocol: connection.protocol,
    credentialMode: connection.credential ? "existing" : canBeKeyless ? "none" : "new",
    credentialId: connection.credential?.id || "",
    credentialName: connection.credential?.name || preset.credentialName,
  };
}

export function buildLlmConnectionInput(draft: LlmConnectionDraft): LlmConnectionInput {
  const input: LlmConnectionInput = {
    name: draft.name.trim(),
    kind: draft.kind,
    provider_id: draft.providerId.trim(),
    protocol: draft.protocol,
  };
  if (draft.baseUrl.trim()) input.base_url = draft.baseUrl.trim();
  if (draft.credentialMode === "existing" && draft.credentialId) {
    input.credential_id = draft.credentialId;
  }
  if (draft.credentialMode === "new" && draft.credentialName.trim() && draft.credentialValue) {
    input.credential = {
      name: draft.credentialName.trim(),
      value: draft.credentialValue,
    };
  }
  return input;
}

export function buildLlmConnectionUpdateInput(draft: LlmConnectionDraft): LlmConnectionInput {
  const input = buildLlmConnectionInput(draft);
  input.base_url = draft.baseUrl.trim() || null;
  if (draft.credentialMode === "none") input.credential_id = null;
  return input;
}

export function validateLlmConnectionDraft(draft: LlmConnectionDraft): string | null {
  if (!draft.name.trim()) return "Connection name is required.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(draft.providerId.trim())) {
    return "Provider ID must use lowercase letters, numbers, dots, underscores, or hyphens.";
  }
  if (draft.kind === "ollama" || draft.kind === "openai-compatible") {
    try {
      const url = new URL(draft.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
      if (url.username || url.password) return "Base URL must not contain credentials.";
    } catch {
      return "Base URL must be a valid http:// or https:// URL.";
    }
  }
  if (draft.kind !== "ollama" && draft.kind !== "openai-compatible") {
    if (draft.credentialMode === "none") return "This provider requires an API key.";
  }
  if (draft.credentialMode === "existing" && !draft.credentialId) {
    return "Select an existing Secret.";
  }
  if (draft.credentialMode === "new" && (!draft.credentialName.trim() || !draft.credentialValue)) {
    return "Enter a name and value for the new Secret.";
  }
  return null;
}

export function modelErrorForProvider(providerId: string, model: string): string | null {
  const value = model.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return "Use OpenCode's canonical provider/model format.";
  }
  if (value.slice(0, slash) !== providerId) {
    return `Model must use the ${providerId} provider.`;
  }
  return null;
}

export function modelPlaceholderForProvider(providerId: string): string {
  return `${providerId || "provider"}/model-id`;
}

export function modelSuggestionsForProvider(providerId: string): string[] {
  switch (providerId) {
    case "openai":
      return ["openai/gpt-5.6", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna"];
    case "anthropic":
      return [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-haiku-4-5",
      ];
    case "openrouter":
      return [
        "openrouter/anthropic/claude-opus-4.8",
        "openrouter/anthropic/claude-sonnet-4.6",
        "openrouter/openai/gpt-5.6-terra",
      ];
    case "ollama":
      return ["ollama/qwen3-coder", "ollama/gpt-oss:20b"];
    default:
      return [];
  }
}

type Props = {
  draft: LlmConnectionDraft;
  onChange: (draft: LlmConnectionDraft) => void;
  secrets: EnvVar[];
  showName?: boolean;
};

export function LlmConnectionFields({ draft, onChange, secrets, showName = true }: Props) {
  function patch(values: Partial<LlmConnectionDraft>) {
    onChange({ ...draft, ...values });
  }

  function changeKind(kind: LlmConnectionKind) {
    const next = createLlmConnectionDraft(kind);
    onChange({ ...next, name: draft.name });
  }

  const acceptsNoCredential = draft.kind === "ollama" || draft.kind === "openai-compatible";
  const showEndpoint = draft.kind === "ollama" || draft.kind === "openai-compatible";

  return (
    <div className="space-y-4">
      {showName && (
        <div className="space-y-2">
          <Label htmlFor="llm-connection-name">Connection name</Label>
          <Input
            id="llm-connection-name"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="e.g. OpenAI production"
            required
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="llm-connection-kind">Provider</Label>
        <select
          id="llm-connection-kind"
          className={SELECT_CLASS}
          value={draft.kind}
          onChange={(event) => changeKind(event.target.value as LlmConnectionKind)}
        >
          {Object.entries(PRESETS).map(([value, preset]) => (
            <option key={value} value={value}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="llm-provider-id">Provider ID</Label>
        <Input
          id="llm-provider-id"
          className="font-mono"
          value={draft.providerId}
          onChange={(event) =>
            patch({
              providerId: event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "-"),
            })
          }
          disabled={draft.kind !== "openai-compatible"}
          required
        />
        <p className="text-xs text-muted-foreground">
          Models use this prefix, for example <code>{draft.providerId || "provider"}/model-id</code>
          .
        </p>
      </div>

      {showEndpoint && (
        <div className="space-y-2">
          <Label htmlFor="llm-base-url">Base URL</Label>
          <Input
            id="llm-base-url"
            className="font-mono"
            type="url"
            value={draft.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
            required
          />
          <p className="text-xs text-muted-foreground">
            This address is resolved on the selected runner. Localhost means that runner machine.
          </p>
        </div>
      )}

      {draft.kind === "openai-compatible" && (
        <div className="space-y-2">
          <Label htmlFor="llm-protocol">API protocol</Label>
          <select
            id="llm-protocol"
            className={SELECT_CLASS}
            value={draft.protocol}
            onChange={(event) => patch({ protocol: event.target.value as LlmProtocol })}
          >
            <option value="chat-completions">Chat Completions</option>
            <option value="responses">Responses</option>
          </select>
        </div>
      )}

      <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
        <div className="space-y-2">
          <Label htmlFor="llm-credential-mode">API key</Label>
          <select
            id="llm-credential-mode"
            className={SELECT_CLASS}
            value={draft.credentialMode}
            onChange={(event) => patch({ credentialMode: event.target.value as CredentialMode })}
          >
            <option value="new">Create a new Secret</option>
            <option value="existing">Use an existing Secret</option>
            {acceptsNoCredential && <option value="none">No API key</option>}
          </select>
          <p className="text-xs text-muted-foreground">
            While bound here, this Secret is reserved for provider authentication and is not
            injected as a normal job Secret.
          </p>
        </div>

        {draft.credentialMode === "existing" && (
          <div className="space-y-2">
            <Label htmlFor="llm-existing-secret">Secret</Label>
            <select
              id="llm-existing-secret"
              className={SELECT_CLASS}
              value={draft.credentialId}
              onChange={(event) => patch({ credentialId: event.target.value })}
              required
            >
              <option value="">Select a Secret</option>
              {secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
            {secrets.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No Secrets exist in this project yet. Create one here instead.
              </p>
            )}
          </div>
        )}

        {draft.credentialMode === "new" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="llm-new-secret-name">Secret name</Label>
              <Input
                id="llm-new-secret-name"
                className="font-mono"
                value={draft.credentialName}
                onChange={(event) =>
                  patch({
                    credentialName: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
                  })
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="llm-new-secret-value">Secret value</Label>
              <Input
                id="llm-new-secret-value"
                type="password"
                value={draft.credentialValue}
                onChange={(event) => patch({ credentialValue: event.target.value })}
                autoComplete="new-password"
                required
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
