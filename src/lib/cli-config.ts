export type CliConfig = {
  name: string;
  models: string[];
  thinkingLabel: string;
  thinkingOptions: string[];
};

export const CLI_CONFIG: Record<string, CliConfig> = {
  claude: {
    name: "Claude",
    models: ["sonnet", "opus", "haiku"],
    thinkingLabel: "Effort",
    thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    name: "Codex",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    thinkingLabel: "Reasoning",
    thinkingOptions: ["low", "medium", "high", "xhigh", "max"],
  },
};

export type CliTool = {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
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

// Agent permission policy — whether the runner may launch the agent's CLI with
// its permission-bypass flag. `enforced` (the default) requires a CLI-native
// policy file in the agent's workspace; `unrestricted` is the deliberate
// per-agent opt-out that keeps the bypass flag.

export const AGENT_PERMISSIONS = ["enforced", "unrestricted"] as const;
export type AgentPermissions = (typeof AGENT_PERMISSIONS)[number];

export function validatePermissions(permissions: unknown): string | null {
  if (
    typeof permissions === "string" &&
    (AGENT_PERMISSIONS as readonly string[]).includes(permissions)
  ) {
    return null;
  }
  return `Invalid permissions "${permissions}". Valid options: ${AGENT_PERMISSIONS.join(", ")}.`;
}

/**
 * Storage/read normalization, fail-closed: only the exact string
 * "unrestricted" passes through; anything else (absent, junk, wrong case)
 * becomes "enforced". The API validates first (400 on junk) — this guards the
 * db layer and values written outside it.
 */
export function normalizePermissions(permissions: unknown): AgentPermissions {
  return permissions === "unrestricted" ? "unrestricted" : "enforced";
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
