import fs from "fs";

const BORG_ROOT = "/Users/davidk/Documents/Borg Interface";

const LIBRARY_PATHS = {
  skills: `${BORG_ROOT}/SKILLS/registry.yaml`,
  plugins: `${BORG_ROOT}/AGENT RESEARCH/agentops/libraries/plugins/registry.yaml`,
  subAgents: `${BORG_ROOT}/AGENT RESEARCH/agentops/libraries/sub-agents/registry.yaml`,
};

export type ToolkitLibraryId = "skills" | "plugins" | "subAgents";

export const RUNTIME_SECURITY = {
  provider: "sage",
  source_repo: "https://github.com/gendigitalinc/sage.git",
  version: "0.9.0",
  enforcement: "hard-gate",
  required_for: ["openclaw", "hermes", "workflow", "future-agent-cli"],
  privacy_profile: "local-first",
  config_path: "~/.sage/config.json",
} as const;

export type ToolkitEntry = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  category: string | null;
  scope: string | null;
  owner_workspace: string | null;
  owner_project: string | null;
  allowed_scopes: string[];
  credential_status: string | null;
  load_policy: string | null;
  risk_level: string | null;
  human_gate: string | null;
  path: string | null;
  capsule: string | null;
  handoff_contract: string | null;
  agent_compatibility: string[];
  tags: string[];
  triggers: string[];
  provenance: string | null;
};

type ParsedLibrary = {
  id: ToolkitLibraryId;
  label: string;
  path: string;
  vmPath: string;
  entries: ToolkitEntry[];
};

type ToolkitScope = {
  includeAll?: boolean;
  workspaceId?: string | null;
  projectId?: string | null;
  agentCli?: string | null;
};

function cleanValue(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseListValue(value: string | null | undefined): string[] {
  const cleaned = cleanValue(value);
  if (!cleaned) return [];
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    return cleaned
      .slice(1, -1)
      .split(",")
      .map(item => cleanValue(item))
      .filter((item): item is string => !!item);
  }
  return cleaned.split(",").map(item => item.trim()).filter(Boolean);
}

function listBlock(text: string, key: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `${key}:`);
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

function parseYamlEntries(text: string, listKey: string): ToolkitEntry[] {
  const block = listBlock(text, listKey);
  const chunks = block.split(/(?:^|\n)\s{2}-\s+id:\s*/).slice(1);
  return chunks.map(chunk => {
    const firstLineEnd = chunk.indexOf("\n");
    const id = cleanValue(firstLineEnd === -1 ? chunk : chunk.slice(0, firstLineEnd)) || "";
    const get = (key: string) => {
      const match = chunk.match(new RegExp(`\\n\\s{4}${key}:\\s*(.+)`));
      return cleanValue(match?.[1]);
    };

    return {
      id,
      name: get("name") || id,
      description: get("description"),
      status: get("status") || "active",
      category: get("category"),
      scope: get("scope"),
      owner_workspace: get("owner_workspace"),
      owner_project: get("owner_project"),
      allowed_scopes: parseListValue(get("allowed_scopes")),
      credential_status: get("credential_status"),
      load_policy: get("load_policy"),
      risk_level: get("risk_level"),
      human_gate: get("human_gate"),
      path: get("path"),
      capsule: get("capsule"),
      handoff_contract: get("handoff_contract"),
      agent_compatibility: parseListValue(get("agent_compatibility")),
      tags: parseListValue(get("tags")),
      triggers: parseListValue(get("triggers")),
      provenance: get("provenance"),
    };
  }).filter(entry => entry.id);
}

function readLibrary(id: ToolkitLibraryId, label: string, listKey: string, vmPath: string): ParsedLibrary {
  const path = LIBRARY_PATHS[id];
  const text = fs.existsSync(/*turbopackIgnore: true*/ path)
    ? fs.readFileSync(/*turbopackIgnore: true*/ path, "utf-8")
    : "";
  return {
    id,
    label,
    path,
    vmPath,
    entries: text ? parseYamlEntries(text, listKey) : [],
  };
}

function slug(value: string | null | undefined) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function ownerMatches(owner: string | null, id: string | null | undefined) {
  if (!owner) return true;
  if (!id) return false;
  return slug(owner) === slug(id);
}

function entryAllowedByScope(entry: ToolkitEntry, scope?: ToolkitScope) {
  if (!scope || scope.includeAll) return true;

  if (entry.scope) {
    if (entry.scope === "global") return true;
    if (entry.scope === "workspace") return !!scope.workspaceId && ownerMatches(entry.owner_workspace, scope.workspaceId);
    if (entry.scope === "project") return !!scope.projectId && ownerMatches(entry.owner_project, scope.projectId);
    if (entry.scope === "brand-kit") {
      return (!!scope.projectId && ownerMatches(entry.owner_project, scope.projectId))
        || (!!scope.workspaceId && ownerMatches(entry.owner_workspace, scope.workspaceId));
    }
    return false;
  }

  if (entry.allowed_scopes.includes("global")) return true;
  if (scope.projectId && entry.allowed_scopes.includes("project")) return true;
  if (scope.workspaceId && entry.allowed_scopes.includes("workspace")) return true;
  return false;
}

function entryCompatibleWithAgent(entry: ToolkitEntry, scope?: ToolkitScope) {
  const agentCli = scope?.agentCli;
  if (agentCli !== "openclaw" && agentCli !== "hermes") return true;
  if (entry.agent_compatibility.length === 0) return true;
  return entry.agent_compatibility.map(item => item.toLowerCase()).includes(agentCli);
}

export function getToolkitLibraries(scope?: ToolkitScope) {
  const libraries = [
    readLibrary("skills", "Skills", "skills", "/opt/borg/toolkit-libraries/skills/registry.yaml"),
    readLibrary("plugins", "Plugins", "plugins", "/opt/borg/toolkit-libraries/plugins/registry.yaml"),
    readLibrary("subAgents", "Sub-agents", "sub_agents", "/opt/borg/toolkit-libraries/sub-agents/registry.yaml"),
  ].map(library => ({
    ...library,
    entries: library.entries
      .filter(entry => entryAllowedByScope(entry, scope))
      .filter(entry => entryCompatibleWithAgent(entry, scope)),
  }));

  return {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    policy: {
      default_load: false,
      search_on_first_spawn_for: ["openclaw", "hermes"],
      scope_order: ["global", "workspace", "project", "brand-kit"],
      deny_by_default: ["destructive actions", "paid services", "external messages", "production deploys"],
    },
    orgo: {
      endpoint: "/api/toolkit-libraries",
      vm_root: "/opt/borg/toolkit-libraries",
      public_namespace: `${BORG_ROOT}/TRON BRAIN/public/toolkit-libraries`,
      mount_mode: "read-only",
      scope_modes: ["global", "workspace", "project", "brand-kit"],
      sync_expectation: "Client VMs fetch this endpoint with Harbour credentials, then mirror allowed manifests under vm_root.",
    },
    runtime_security: RUNTIME_SECURITY,
    libraries,
  };
}
