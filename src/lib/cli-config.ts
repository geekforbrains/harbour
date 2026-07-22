export type CliConfig = {
  name: string;
  models: string[];
  thinkingLabel: string;
  thinkingOptions: string[];
  modelInput?: "select" | "text";
  thinkingInput?: "select" | "text";
};

export const OPENCODE_MIN_VERSION = "1.17.12";

function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = String(value || "").match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedCliVersion(cli: string, version: string | null | undefined): boolean {
  if (cli !== "opencode") return true;
  const actual = parseVersion(version);
  const minimum = parseVersion(OPENCODE_MIN_VERSION)!;
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export const CLI_CONFIG: Record<string, CliConfig> = {
  claude: {
    name: "Claude",
    models: ["sonnet", "opus", "haiku"],
    thinkingLabel: "Effort",
    thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    name: "Codex",
    models: ["gpt-5.5", "gpt-5.4"],
    thinkingLabel: "Reasoning",
    thinkingOptions: ["low", "medium", "high", "xhigh"],
  },
  opencode: {
    name: "OpenCode",
    models: [],
    thinkingLabel: "Variant",
    thinkingOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    modelInput: "text",
    thinkingInput: "text",
  },
};

export type CliTool = {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  compatible?: boolean;
  compatibilityReason?: string;
};

/**
 * Server-side detection describes only the Harbour host. Keep every CLI the
 * runner protocol supports in the picker so a remotely placed agent can be
 * configured before its runner is online (or when the server host lacks it).
 */
export function mergeSupportedCliTools(detected: CliTool[]): CliTool[] {
  const byId = new Map(detected.map((tool) => [tool.id, tool]));
  return Object.entries(CLI_CONFIG).map(([id, config]) => {
    const tool = byId.get(id);
    return tool ?? { id, name: config.name, installed: false };
  });
}

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
  if (config.thinkingInput === "text") {
    if (
      typeof thinking === "string" &&
      thinking.length <= 64 &&
      /^[A-Za-z0-9._-]+$/.test(thinking)
    ) {
      return null;
    }
    return `Invalid ${config.thinkingLabel.toLowerCase()} "${thinking}" for ${cli}. Use at most 64 letters, numbers, dots, underscores, or hyphens.`;
  }
  if (typeof thinking !== "string" || !config.thinkingOptions.includes(thinking)) {
    return `Invalid thinking level "${thinking}" for ${cli}. Valid options: ${config.thinkingOptions.join(", ")} (or empty for the CLI default).`;
  }
  return null;
}
