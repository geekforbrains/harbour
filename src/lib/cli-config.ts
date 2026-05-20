export type CliConfig = {
  models: string[];
  thinkingLabel: string;
  thinkingOptions: string[];
};

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
};
