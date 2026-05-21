#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";

const BORG_ROOT = "/Users/davidk/Documents/Borg Interface";
const HARBOUR_HOME = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
const DB_PATH = process.env.HARBOUR_DB_PATH || path.join(HARBOUR_HOME, "harbour.db");
const AGENT_KEYS_FILE = path.join(HARBOUR_HOME, "agentops-agent-keys.json");
const RUNNERS_FILE = path.join(HARBOUR_HOME, "runners.json");
const DEFAULT_RUNNER_URL = process.env.HARBOUR_RUNNER_URL || process.env.HARBOUR_BASE_URL || "http://localhost:3001";
const LIBRARIES = {
  skills: path.join(BORG_ROOT, "SKILLS/registry.yaml"),
  plugins: path.join(BORG_ROOT, "AGENT RESEARCH/agentops/libraries/plugins/registry.yaml"),
  subAgents: path.join(BORG_ROOT, "AGENT RESEARCH/agentops/libraries/sub-agents/registry.yaml"),
};
const AGENTOPS_REGISTRY = path.join(BORG_ROOT, "AGENT RESEARCH/agentops/registry/agents-registry.yaml");

function clean(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  return trimmed.replace(/^["']|["']$/g, "");
}

function listBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `${key}:`);
  if (start === -1) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

function getValue(chunk, key) {
  const match = chunk.match(new RegExp(`\\n\\s{4}${key}:\\s*(.+)`));
  return clean(match?.[1]);
}

function listForStorage(value) {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const raw = cleaned.startsWith("[") && cleaned.endsWith("]") ? cleaned.slice(1, -1) : cleaned;
  const items = raw.split(",").map(item => clean(item)).filter(Boolean);
  return items.length ? JSON.stringify(items) : null;
}

function parseEntries(file, key) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf-8");
  return listBlock(text, key).split(/(?:^|\n)\s{2}-\s+id:\s*/).slice(1).map(chunk => {
    const firstLineEnd = chunk.indexOf("\n");
    const id = clean(firstLineEnd === -1 ? chunk : chunk.slice(0, firstLineEnd));
    return {
      id,
      name: getValue(chunk, "name") || id,
      description: getValue(chunk, "description"),
      scope: getValue(chunk, "scope") || "global",
      owner_workspace: getValue(chunk, "owner_workspace"),
      owner_project: getValue(chunk, "owner_project"),
      source_agent: getValue(chunk, "source_agent"),
      status: getValue(chunk, "status") || "active",
      path: getValue(chunk, "path"),
      provenance: getValue(chunk, "provenance") || "Imported from toolkit library sync.",
      version: getValue(chunk, "version"),
      dependencies: getValue(chunk, "dependencies"),
      agent_compatibility: listForStorage(getValue(chunk, "agent_compatibility") || "[openclaw, hermes]"),
      tags: getValue(chunk, "tags"),
      triggers: getValue(chunk, "triggers"),
    };
  }).filter(entry => entry.id);
}

function digestSkill(entry) {
  const parts = [
    entry.description,
    entry.tags ? `Tags: ${entry.tags}` : null,
    entry.triggers ? `Triggers: ${entry.triggers}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

function ensureToolkitColumns(db) {
  const skillCols = db.prepare("PRAGMA table_info(skills)").all();
  if (!skillCols.some(col => col.name === "agent_compatibility")) {
    db.exec("ALTER TABLE skills ADD COLUMN agent_compatibility TEXT");
  }
}

function readYamlAsJson(file) {
  if (!fs.existsSync(file)) return null;
  const script = [
    "import json, sys, yaml",
    "with open(sys.argv[1], encoding='utf-8') as f:",
    "    print(json.dumps(yaml.safe_load(f)))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, file], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Failed to parse YAML ${file}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function getHarbourTimezone(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("timezone");
    return row?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

function nowInTz(tz, from = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(from);
  const get = type => parts.find(part => part.type === type)?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    realNow: from,
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function tzDateToEpoch(tz, year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  const offsetMs = ((day - get("day")) * 86400 + (hour - get("hour")) * 3600 + (minute - get("minute")) * 60) * 1000;
  return Math.floor((probe.getTime() + offsetMs) / 1000);
}

function nextRunAt(schedule, timezone) {
  try {
    const parsed = JSON.parse(schedule || "{}");
    const now = new Date();
    if (typeof parsed.every === "number" && parsed.every > 0) {
      const ms = parsed.every * 60000;
      return Math.floor((Math.ceil(now.getTime() / ms) * ms) / 1000);
    }
    if (Array.isArray(parsed.days) && typeof parsed.time === "string") {
      const [hour, minute] = parsed.time.split(":").map(Number);
      const days = parsed.days.length ? [...new Set(parsed.days)].sort((a, b) => a - b) : ALL_DAYS;
      const tn = nowInTz(timezone, now);
      const currentEpoch = Math.floor(now.getTime() / 1000);
      for (let offset = 0; offset <= 7; offset += 1) {
        const weekday = (tn.weekday + offset) % 7;
        if (!days.includes(weekday)) continue;
        const candidateDate = new Date(Date.UTC(tn.year, tn.month - 1, tn.day + offset));
        const epoch = tzDateToEpoch(
          timezone,
          candidateDate.getUTCFullYear(),
          candidateDate.getUTCMonth() + 1,
          candidateDate.getUTCDate(),
          hour,
          minute,
        );
        if (epoch > currentEpoch) return epoch;
      }
    }
  } catch {}
  return null;
}

function loadAgentKeys() {
  if (!fs.existsSync(AGENT_KEYS_FILE)) return {};
  return JSON.parse(fs.readFileSync(AGENT_KEYS_FILE, "utf-8"));
}

function saveAgentKeys(keys) {
  fs.writeFileSync(AGENT_KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  try { fs.chmodSync(AGENT_KEYS_FILE, 0o600); } catch {}
}

function getOrCreateApiKey(keys, agentId) {
  if (!keys[agentId]) {
    keys[agentId] = `hbr_${crypto.randomBytes(32).toString("hex")}`;
  }
  return keys[agentId];
}

function loadRunners() {
  if (!fs.existsSync(RUNNERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RUNNERS_FILE, "utf-8")).runners || [];
  } catch {
    return [];
  }
}

function saveRunners(runners) {
  fs.writeFileSync(RUNNERS_FILE, JSON.stringify({ runners }, null, 2));
}

function syncLocalRunnerConfigs(records, keys) {
  const runners = loadRunners();
  let synced = 0;

  for (const record of records) {
    if (record.type !== "harbour" || record.remote) continue;
    const apiKey = getOrCreateApiKey(keys, record.id);
    const nextRunner = {
      agentId: record.id,
      name: record.name,
      apiKey,
      cli: record.cli,
      model: record.model,
      thinking: record.thinking,
      eager: !!record.eager,
      url: DEFAULT_RUNNER_URL,
    };
    const existingIndex = runners.findIndex(runner => runner.agentId === record.id);
    if (existingIndex >= 0) {
      runners[existingIndex] = { ...runners[existingIndex], ...nextRunner };
    } else {
      runners.push(nextRunner);
    }
    synced += 1;
  }

  if (synced > 0) saveRunners(runners);
  return synced;
}

function extractAgentOpsHarbourRecords(registry) {
  const agents = Array.isArray(registry?.agents) ? registry.agents : [];
  return agents
    .filter(agent => agent?.harbour?.cli)
    .map(agent => {
      const h = agent.harbour || {};
      const scopeType = h.scope_type || "global";
      return {
        id: agent.id,
        name: agent.display_name || agent.id,
        description: agent.description || null,
        type: h.agent_type || "harbour",
        cli: h.cli,
        model: h.model || null,
        thinking: h.thinking || null,
        remote: h.remote ? 1 : 0,
        eager: h.eager ? 1 : 0,
        scopeType,
        workspaceId: scopeType === "workspace" ? (h.workspace_id || agent.workspace || null) : null,
        projectId: scopeType === "project" ? (h.project_id || agent.project || null) : null,
        composioCliEnabled: h.composio_cli_enabled ? 1 : 0,
        composioMcpEnabled: h.composio_mcp_enabled ? 1 : 0,
        composioToolkits: Array.isArray(h.composio_toolkits) ? JSON.stringify(h.composio_toolkits) : null,
        composioTools: Array.isArray(h.composio_tools) ? JSON.stringify(h.composio_tools) : null,
        defaultJob: h.default_job || null,
      };
    });
}

function syncAgentOpsHarbourRecords(db, records) {
  const keys = loadAgentKeys();
  const timezone = getHarbourTimezone(db);
  let syncedAgents = 0;
  let syncedJobs = 0;

  const upsertAgent = db.prepare(`
    INSERT INTO agents (
      id, name, description, api_key_hash, type, cli, model, thinking, remote, eager,
      scope_type, workspace_id, project_id, composio_cli_enabled, composio_mcp_enabled,
      composio_toolkits, composio_tools, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      type = excluded.type,
      cli = excluded.cli,
      model = excluded.model,
      thinking = excluded.thinking,
      remote = excluded.remote,
      eager = excluded.eager,
      scope_type = excluded.scope_type,
      workspace_id = excluded.workspace_id,
      project_id = excluded.project_id,
      composio_cli_enabled = excluded.composio_cli_enabled,
      composio_mcp_enabled = excluded.composio_mcp_enabled,
      composio_toolkits = excluded.composio_toolkits,
      composio_tools = excluded.composio_tools,
      updated_at = unixepoch()
  `);

  const upsertJob = db.prepare(`
    INSERT INTO jobs (
      id, agent_id, name, description, instructions, schedule, workflow_command,
      workflow_only, timeout_minutes, one_off, active, next_run_at, model, thinking, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 30, 0, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      agent_id = excluded.agent_id,
      name = excluded.name,
      description = excluded.description,
      instructions = excluded.instructions,
      schedule = excluded.schedule,
      workflow_only = 0,
      timeout_minutes = 30,
      one_off = 0,
      active = excluded.active,
      next_run_at = excluded.next_run_at,
      model = excluded.model,
      thinking = excluded.thinking,
      updated_at = unixepoch()
  `);
  const linkProjectAgent = db.prepare(`
    INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)
  `);
  const linkProjectJob = db.prepare(`
    INSERT OR IGNORE INTO project_jobs (project_id, job_id) VALUES (?, ?)
  `);

  for (const record of records) {
    const apiKey = getOrCreateApiKey(keys, record.id);
    upsertAgent.run(
      record.id,
      record.name,
      record.description,
      hashApiKey(apiKey),
      record.type,
      record.cli,
      record.model,
      record.thinking,
      record.remote,
      record.eager,
      record.scopeType,
      record.workspaceId,
      record.projectId,
      record.composioCliEnabled,
      record.composioMcpEnabled,
      record.composioToolkits,
      record.composioTools,
    );
    syncedAgents += 1;
    if (record.projectId) {
      linkProjectAgent.run(record.projectId, record.id);
    }

    if (record.defaultJob?.id) {
      const active = record.defaultJob.active === false ? 0 : 1;
      const schedule = record.defaultJob.schedule || "{}";
      upsertJob.run(
        record.defaultJob.id,
        record.id,
        record.defaultJob.name || `${record.name} On Demand`,
        record.description,
        record.defaultJob.instructions || null,
        schedule,
        active,
        active ? nextRunAt(schedule, timezone) : null,
        record.model,
        record.thinking,
      );
      if (record.projectId) {
        linkProjectJob.run(record.projectId, record.defaultJob.id);
      }
      syncedJobs += 1;
    }
  }

  const syncedRunners = syncLocalRunnerConfigs(records, keys);
  saveAgentKeys(keys);
  return { syncedAgents, syncedJobs, syncedRunners };
}

fs.mkdirSync(HARBOUR_HOME, { recursive: true });

const skillEntries = parseEntries(LIBRARIES.skills, "skills");
const pluginEntries = parseEntries(LIBRARIES.plugins, "plugins");
const subAgentEntries = parseEntries(LIBRARIES.subAgents, "sub_agents");
const agentOpsRegistry = readYamlAsJson(AGENTOPS_REGISTRY);
const agentOpsHarbourRecords = extractAgentOpsHarbourRecords(agentOpsRegistry);

let syncedSkills = 0;
let syncedAgentOpsAgents = 0;
let syncedAgentOpsJobs = 0;
let syncedAgentOpsRunners = 0;
let touchedAgents = 0;

if (fs.existsSync(DB_PATH)) {
  const db = new Database(DB_PATH);
  ensureToolkitColumns(db);
  const upsert = db.prepare(`
    INSERT INTO skills (
      id, name, description, scope, owner_workspace, owner_project, source_agent, status,
      path, provenance, version, dependencies, agent_compatibility, tags, triggers, digest, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      scope = excluded.scope,
      owner_workspace = excluded.owner_workspace,
      owner_project = excluded.owner_project,
      source_agent = excluded.source_agent,
      status = excluded.status,
      path = excluded.path,
      provenance = excluded.provenance,
      version = excluded.version,
      dependencies = excluded.dependencies,
      agent_compatibility = excluded.agent_compatibility,
      tags = excluded.tags,
      triggers = excluded.triggers,
      digest = excluded.digest,
      updated_at = unixepoch()
  `);
  const sync = db.transaction(() => {
    for (const skill of skillEntries) {
      upsert.run(
        skill.id,
        skill.name,
        skill.description,
        skill.scope,
        skill.owner_workspace,
        skill.owner_project,
        skill.source_agent,
        skill.status,
        skill.path,
        skill.provenance,
        skill.version,
        skill.dependencies,
        skill.agent_compatibility,
        skill.tags,
        skill.triggers,
        digestSkill(skill),
      );
      syncedSkills += 1;
    }
    const result = db.prepare(`
      UPDATE agents
      SET updated_at = unixepoch()
    `).run();
    touchedAgents = Number(result.changes || 0);

    const agentOpsSync = syncAgentOpsHarbourRecords(db, agentOpsHarbourRecords);
    syncedAgentOpsAgents = agentOpsSync.syncedAgents;
    syncedAgentOpsJobs = agentOpsSync.syncedJobs;
    syncedAgentOpsRunners = agentOpsSync.syncedRunners;
  });
  sync();
  db.close();
}

const snapshot = {
  generated_at: new Date().toISOString(),
  libraries: {
    skills: { path: LIBRARIES.skills, entries: skillEntries.length },
    plugins: { path: LIBRARIES.plugins, entries: pluginEntries.length },
    subAgents: { path: LIBRARIES.subAgents, entries: subAgentEntries.length },
    agentOpsAgents: { path: AGENTOPS_REGISTRY, entries: agentOpsHarbourRecords.length },
  },
  syncedSkills,
  syncedAgentOpsAgents,
  syncedAgentOpsJobs,
  syncedAgentOpsRunners,
  touchedAgents,
  vmRoot: "/opt/borg/toolkit-libraries",
};

fs.writeFileSync(path.join(HARBOUR_HOME, "toolkit-libraries.json"), JSON.stringify(snapshot, null, 2));

console.log(`Toolkit libraries synced: ${syncedSkills} skills, ${pluginEntries.length} plugins, ${subAgentEntries.length} sub-agents. Synced ${syncedAgentOpsAgents} AgentOps Harbour agent(s), ${syncedAgentOpsJobs} job(s), ${syncedAgentOpsRunners} local runner config(s). Touched ${touchedAgents} agents.`);
