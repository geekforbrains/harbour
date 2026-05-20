export type CliConfig = {
  models: string[];
  thinkingLabel: string;
  thinkingOptions: string[];
};

export const CLI_CONFIG: Record<string, CliConfig> = {
  claude: {
    models: ["sonnet", "opus", "haiku"],
    thinkingLabel: "Effort",
    thinkingOptions: ["low", "medium", "high", "max"],
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
};
