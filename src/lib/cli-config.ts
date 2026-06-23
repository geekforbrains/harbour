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

// API-side validation against the config above (issue #39: an unvalidated
// thinking level reached the CLI as `--effort off` and failed every run at
// launch). Both return an error message for a 400 response, or null when
// valid. `model` is deliberately not validated — the CLIs accept arbitrary
// model strings (full model IDs, dated snapshots); `models` above is only the
// dashboard's convenience list.

export function validateCli(cli: unknown): string | null {
  if (typeof cli === "string" && CLI_CONFIG[cli]) return null;
  return `Invalid cli "${cli}". Valid options: ${Object.keys(CLI_CONFIG).join(", ")}.`;
}

export function validateThinking(cli: unknown, thinking: unknown): string | null {
  // Empty means "use the CLI default" and is always valid.
  if (thinking === undefined || thinking === null || thinking === "") return null;
  const config = typeof cli === "string" ? CLI_CONFIG[cli] : undefined;
  if (!config) {
    return `A thinking level requires a valid cli (got "${cli}").`;
  }
  if (config.thinkingOptions.length === 0) {
    return `${cli} does not take a thinking level — leave it empty.`;
  }
  if (typeof thinking !== "string" || !config.thinkingOptions.includes(thinking)) {
    return `Invalid thinking level "${thinking}" for ${cli}. Valid options: ${config.thinkingOptions.join(", ")} (or empty for the CLI default).`;
  }
  return null;
}
