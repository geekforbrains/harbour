export type CliConfig = {
  models: CliModelOption[];
  thinkingLabel: string;
  thinkingOptions: string[];
};

export type CliModelOption = string | {
  value: string;
  label: string;
  group?: string;
};

export function modelOptionValue(option: CliModelOption): string {
  return typeof option === "string" ? option : option.value;
}

export function modelOptionLabel(option: CliModelOption): string {
  return typeof option === "string" ? option : option.label;
}

export const CLI_CONFIG: Record<string, CliConfig> = {
  claude: {
    models: ["sonnet", "opus", "haiku"],
    thinkingLabel: "Effort",
    thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    models: ["gpt-5.5", "gpt-5.4"],
    thinkingLabel: "Reasoning",
    thinkingOptions: ["low", "medium", "high", "xhigh"],
  },
  gemini: {
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    thinkingLabel: "Thinking",
    // Gemini 0.40+ removed --thinking; reasoning depth is controlled by model
    // selection now. Empty array hides the thinking selector in the UI.
    thinkingOptions: [],
  },
  pi: {
    // Pi (earendil-works/pi) — multi-provider coding agent.
    // Install: npm install -g @mariozechner/pi-coding-agent
    // Models use "provider/model" format. Run `pi /login` to authenticate.
    // Supports Anthropic, OpenAI, Google, Groq, Ollama, OpenRouter, and 15+ more.
    models: [
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.5-pro",
      "groq/llama-3.3-70b-versatile",
      "ollama/qwen3:8b",
    ],
    thinkingLabel: "Thinking",
    // Pi --thinking levels: off | minimal | low | medium | high | xhigh
    thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh"],
  },
  opencode: {
    // OpenCode (opencode-ai/opencode) — open source terminal coding agent.
    // Install: npm install -g opencode-ai
    // Models use "provider/model" format. Run `opencode auth login` to set API keys.
    // Supports Anthropic, OpenAI, Google, Groq, Ollama, OpenRouter, and 40+ more.
    models: [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "ollama/qwen3:8b",
    ],
    thinkingLabel: "Thinking",
    // OpenCode uses --variant for provider-specific reasoning effort, not a
    // standard thinking level — leave empty to hide the selector.
    thinkingOptions: [],
  },
  openclaw: {
    models: [
      { value: "auto", label: "Free API auto (FreeLLM)", group: "Free" },
      { value: "ollama/gpt-oss:20b", label: "Ollama GPT-OSS 20B", group: "Free local" },
      { value: "ollama/qwen2.5:7b", label: "Ollama Qwen 2.5 7B", group: "Free local" },
      { value: "groq/openai/gpt-oss-120b", label: "GPT-OSS 120B via Groq", group: "Cheap open-source" },
      { value: "openrouter/qwen/qwen3-coder:free", label: "Qwen3 Coder via OpenRouter", group: "Cheap open-source" },
      { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "Frontier" },
      { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Frontier" },
      { value: "openai/gpt-5.5", label: "GPT-5.5", group: "Frontier" },
    ],
    thinkingLabel: "Thinking",
    thinkingOptions: ["low", "medium", "high"],
  },
  hermes: {
    models: [
      { value: "auto", label: "Free API auto (FreeLLM)", group: "Free" },
      { value: "gpt-oss:20b", label: "Ollama GPT-OSS 20B", group: "Free local" },
      { value: "qwen2.5:7b", label: "Ollama Qwen 2.5 7B", group: "Free local" },
      { value: "openai/gpt-oss-120b", label: "GPT-OSS 120B", group: "Cheap open-source" },
      { value: "qwen/qwen3-coder:free", label: "Qwen3 Coder", group: "Cheap open-source" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "Frontier" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Frontier" },
      { value: "gpt-5.5", label: "GPT-5.5", group: "Frontier" },
      { value: "hermes-3", label: "Hermes 3", group: "Hermes" },
      { value: "nous-hermes-3", label: "Nous Hermes 3", group: "Hermes" },
    ],
    thinkingLabel: "Thinking",
    thinkingOptions: ["low", "medium", "high"],
  },
};
