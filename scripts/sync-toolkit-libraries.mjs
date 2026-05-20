#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const BORG_ROOT = "/Users/davidk/Documents/Borg Interface";
const HARBOUR_HOME = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
const DB_PATH = process.env.HARBOUR_DB_PATH || path.join(HARBOUR_HOME, "harbour.db");
const LIBRARIES = {
  skills: path.join(BORG_ROOT, "SKILLS/registry.yaml"),
  plugins: path.join(BORG_ROOT, "AGENT RESEARCH/agentops/libraries/plugins/registry.yaml"),
  subAgents: path.join(BORG_ROOT, "AGENT RESEARCH/agentops/libraries/sub-agents/registry.yaml"),
};

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

fs.mkdirSync(HARBOUR_HOME, { recursive: true });

const skillEntries = parseEntries(LIBRARIES.skills, "skills");
const pluginEntries = parseEntries(LIBRARIES.plugins, "plugins");
const subAgentEntries = parseEntries(LIBRARIES.subAgents, "sub_agents");

let syncedSkills = 0;
let touchedAgents = 0;

if (fs.existsSync(DB_PATH)) {
  const db = new Database(DB_PATH);
  const upsert = db.prepare(`
    INSERT INTO skills (
      id, name, description, scope, owner_workspace, owner_project, source_agent, status,
      path, provenance, version, dependencies, tags, triggers, digest, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
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
  },
  syncedSkills,
  touchedAgents,
  vmRoot: "/opt/borg/toolkit-libraries",
};

fs.writeFileSync(path.join(HARBOUR_HOME, "toolkit-libraries.json"), JSON.stringify(snapshot, null, 2));

console.log(`Toolkit libraries synced: ${syncedSkills} skills, ${pluginEntries.length} plugins, ${subAgentEntries.length} sub-agents. Touched ${touchedAgents} agents.`);
