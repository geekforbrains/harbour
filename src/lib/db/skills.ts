import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

const SKILLS_ROOT = "/Users/davidk/Documents/Borg Interface/SKILLS";

export type SkillScope = "global" | "workspace" | "project" | "brand-kit";

export type SkillRecord = {
  id: string;
  name: string;
  description: string | null;
  scope: SkillScope;
  owner_workspace: string | null;
  owner_project: string | null;
  source_agent: string | null;
  status: "active" | "draft" | "archived";
  path: string | null;
  provenance: string | null;
  version: string | null;
  dependencies: string | null;
  tags: string | null;
  triggers: string | null;
  digest: string | null;
  content: string | null;
  created_at: number;
  updated_at: number;
};

type SkillProposalRecord = Omit<SkillRecord, "status"> & {
  status: "proposed" | "promoted" | "rejected";
  rejection_reason: string | null;
};

type AgentScopeRow = {
  id: string;
  scope_type: SkillScope | "global" | "workspace" | "project";
  workspace_id: string | null;
  project_id: string | null;
};

type SkillInput = {
  id?: string;
  name: string;
  description?: string | null;
  scope?: SkillScope;
  owner_workspace?: string | null;
  owner_project?: string | null;
  source_agent?: string | null;
  status?: "active" | "draft" | "archived";
  path?: string | null;
  provenance?: string | string[] | null;
  version?: string | null;
  dependencies?: string[] | string | null;
  tags?: string[] | string | null;
  triggers?: string[] | string | null;
  digest?: string | null;
  content?: string | null;
};

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || uuid();
}

function encodeList(value?: string[] | string | null) {
  if (Array.isArray(value)) return JSON.stringify(value.filter(Boolean));
  if (typeof value === "string" && value.trim()) {
    return JSON.stringify(value.split(",").map(v => v.trim()).filter(Boolean));
  }
  return null;
}

function encodeText(value?: string | string[] | null) {
  if (Array.isArray(value)) return value.join("\n");
  return value || null;
}

function frontmatter(content: string) {
  if (!content.startsWith("---")) return { meta: {} as Record<string, string>, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta: {} as Record<string, string>, body: content };
  const raw = content.slice(3, end).trim();
  const meta: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: content.slice(end + 4).trim() };
}

function digestSkill(content: string) {
  const { meta, body } = frontmatter(content);
  const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 12);
  const description = meta.description || body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith("#"))?.trim() || "";
  const clippedDescription = description.replace(/\s+/g, " ").slice(0, 600);
  return [
    clippedDescription,
    headings.length ? `Headings: ${headings.join("; ")}` : "",
  ].filter(Boolean).join("\n\n");
}

function parseSkillMarkdown(content: string, fallbackPath?: string): SkillInput {
  const { meta } = frontmatter(content);
  const name = meta.name || path.basename(path.dirname(fallbackPath || "skill"));
  return {
    id: slugify(meta.id || meta.name || name),
    name,
    description: meta.description || null,
    scope: (meta.scope as SkillScope) || "global",
    owner_workspace: meta.owner_workspace || null,
    owner_project: meta.owner_project || null,
    source_agent: meta.source_agent || "upload",
    path: fallbackPath || null,
    provenance: meta.provenance || "Imported into Harbour skill library.",
    version: meta.version || null,
    tags: meta.tags || null,
    triggers: meta.triggers || null,
    digest: digestSkill(content),
    content,
  };
}

function parseRegistryYaml(text: string): SkillInput[] {
  const skillsBlock = text.split(/\nskills:\s*\n/)[1]?.split(/\nbrand_kits:/)[0] || "";
  const chunks = skillsBlock.split(/(?:^|\n)\s*-\s+id:\s+/).slice(1);
  return chunks.map((chunk) => {
    const firstLineEnd = chunk.indexOf("\n");
    const id = (firstLineEnd === -1 ? chunk : chunk.slice(0, firstLineEnd)).trim().replace(/^["']|["']$/g, "");
    const get = (key: string) => {
      const match = chunk.match(new RegExp(`\\n\\s+${key}:\\s*(.+)`));
      if (!match) return null;
      const raw = match[1].trim();
      if (raw === "null") return null;
      return raw.replace(/^["']|["']$/g, "");
    };
    const relPath = get("path");
    const fullPath = relPath ? (path.isAbsolute(relPath) ? relPath : path.join(SKILLS_ROOT, relPath)) : null;
    const content = fullPath && fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;
    return {
      id,
      name: get("name") || id,
      description: get("description"),
      scope: ((get("scope") || "global") as SkillScope),
      owner_workspace: get("owner_workspace"),
      owner_project: get("owner_project"),
      source_agent: get("source_agent"),
      status: ((get("status") || "active") as "active"),
      path: relPath,
      provenance: get("provenance") || "Imported from SKILLS/registry.yaml.",
      version: get("version"),
      dependencies: get("dependencies"),
      tags: get("tags"),
      triggers: get("triggers"),
      digest: content ? digestSkill(content) : null,
      content,
    };
  });
}

export function upsertSkill(input: SkillInput) {
  const db = getDb();
  const id = input.id || slugify(input.name);
  db.prepare(`
    INSERT INTO skills (
      id, name, description, scope, owner_workspace, owner_project, source_agent, status,
      path, provenance, version, dependencies, tags, triggers, digest, content, updated_at
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
      tags = excluded.tags,
      triggers = excluded.triggers,
      digest = excluded.digest,
      content = excluded.content,
      updated_at = unixepoch()
  `).run(
    id,
    input.name,
    input.description || null,
    input.scope || "global",
    input.owner_workspace || null,
    input.owner_project || null,
    input.source_agent || null,
    input.status || "active",
    input.path || null,
    encodeText(input.provenance),
    input.version || null,
    encodeList(input.dependencies),
    encodeList(input.tags),
    encodeList(input.triggers),
    input.digest || null,
    input.content || null,
  );
  return getSkill(id);
}

export function getSkill(id: string): SkillRecord | null {
  return getDb().prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as SkillRecord | undefined || null;
}

export function listSkills(opts: { q?: string; status?: string; scope?: string } = {}) {
  const db = getDb();
  const where: string[] = [];
  const values: string[] = [];
  if (opts.status) { where.push("status = ?"); values.push(opts.status); }
  if (opts.scope) { where.push("scope = ?"); values.push(opts.scope); }
  if (opts.q) {
    where.push("(name LIKE ? OR description LIKE ? OR digest LIKE ? OR tags LIKE ?)");
    const q = `%${opts.q}%`;
    values.push(q, q, q, q);
  }
  return db.prepare(`SELECT * FROM skills ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY scope, name`).all(...values) as SkillRecord[];
}

export function importSkillsFromFilesystem() {
  const registry = path.join(SKILLS_ROOT, "registry.yaml");
  const imported: SkillRecord[] = [];
  if (fs.existsSync(registry)) {
    for (const skill of parseRegistryYaml(fs.readFileSync(registry, "utf-8"))) {
      const saved = upsertSkill(skill);
      if (saved) imported.push(saved);
    }
  }
  return imported;
}

export function importSkillContent(content: string, sourcePath?: string) {
  return upsertSkill(parseSkillMarkdown(content, sourcePath));
}

export function createSkillProposal(input: SkillInput & { content: string }) {
  const db = getDb();
  const id = input.id || slugify(input.name);
  db.prepare(`
    INSERT INTO skill_proposals (
      id, name, description, scope, owner_workspace, owner_project, source_agent,
      path, provenance, version, dependencies, tags, triggers, digest, content, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', unixepoch())
  `).run(
    id,
    input.name,
    input.description || null,
    input.scope || "global",
    input.owner_workspace || null,
    input.owner_project || null,
    input.source_agent || null,
    input.path || null,
    encodeText(input.provenance),
    input.version || null,
    encodeList(input.dependencies),
    encodeList(input.tags),
    encodeList(input.triggers),
    input.digest || digestSkill(input.content),
    input.content,
  );
  return getSkillProposal(id);
}

export function getSkillProposal(id: string) {
  return getDb().prepare(`SELECT * FROM skill_proposals WHERE id = ?`).get(id) as SkillProposalRecord | undefined || null;
}

export function listSkillProposals(status?: string) {
  const db = getDb();
  if (status) return db.prepare(`SELECT * FROM skill_proposals WHERE status = ? ORDER BY created_at DESC`).all(status);
  return db.prepare(`SELECT * FROM skill_proposals ORDER BY created_at DESC`).all();
}

export function promoteSkillProposal(id: string) {
  const db = getDb();
  const proposal = getSkillProposal(id);
  if (!proposal) return null;
  const skill = upsertSkill({
    id: proposal.id,
    name: proposal.name,
    description: proposal.description,
    scope: proposal.scope,
    owner_workspace: proposal.owner_workspace,
    owner_project: proposal.owner_project,
    source_agent: proposal.source_agent,
    status: "active",
    path: proposal.path,
    provenance: proposal.provenance,
    version: proposal.version,
    dependencies: proposal.dependencies,
    tags: proposal.tags,
    triggers: proposal.triggers,
    digest: proposal.digest,
    content: proposal.content,
  });
  db.prepare(`UPDATE skill_proposals SET status = 'promoted', updated_at = unixepoch() WHERE id = ?`).run(id);
  return skill;
}

export function rejectSkillProposal(id: string, reason?: string) {
  const db = getDb();
  db.prepare(`UPDATE skill_proposals SET status = 'rejected', rejection_reason = ?, updated_at = unixepoch() WHERE id = ?`).run(reason || null, id);
  return getSkillProposal(id);
}

export function archiveSkill(id: string) {
  const db = getDb();
  db.prepare(`UPDATE skills SET status = 'archived', updated_at = unixepoch() WHERE id = ?`).run(id);
  return getSkill(id);
}

export function getAgentSkillOverrides(agentId: string) {
  return getDb().prepare(`SELECT skill_id, mode FROM agent_skills WHERE agent_id = ? ORDER BY skill_id`).all(agentId) as { skill_id: string; mode: "include" | "exclude" }[];
}

export function setAgentSkillOverrides(agentId: string, overrides: { skillId: string; mode: "include" | "exclude" }[]) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM agent_skills WHERE agent_id = ?`).run(agentId);
    const stmt = db.prepare(`INSERT OR REPLACE INTO agent_skills (agent_id, skill_id, mode) VALUES (?, ?, ?)`);
    for (const override of overrides) stmt.run(agentId, override.skillId, override.mode);
  })();
  return getAgentSkillOverrides(agentId);
}

function decodeList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value.split(",").map(v => v.trim()).filter(Boolean);
  }
}

function skillMatchesRun(skill: SkillRecord, queryText?: string) {
  if (skill.scope === "global") return true;
  if (!queryText?.trim()) return true;
  const query = queryText.toLowerCase();
  const signals = [...decodeList(skill.tags), ...decodeList(skill.triggers)];
  if (signals.length > 0) {
    return signals.some(signal => query.includes(signal.toLowerCase()));
  }
  const fallback = [skill.name, skill.description, skill.digest].filter(Boolean).join("\n").toLowerCase();
  return fallback.split(/\s+/).some(token => token.length > 4 && query.includes(token));
}

export function resolveSkillsForAgent(agentId: string, queryText?: string) {
  const db = getDb();
  const agent = db.prepare(`SELECT id, scope_type, workspace_id, project_id FROM agents WHERE id = ?`).get(agentId) as AgentScopeRow | undefined;
  if (!agent) return [];

  let workspaceId = agent.workspace_id as string | null;
  if (!workspaceId && agent.project_id) {
    const project = db.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(agent.project_id) as { workspace_id: string | null } | undefined;
    workspaceId = project?.workspace_id || null;
  }

  const scoped = db.prepare(`
    SELECT * FROM skills
    WHERE status = 'active'
      AND (
        scope = 'global'
        OR (scope = 'workspace' AND owner_workspace = ?)
        OR (scope = 'project' AND owner_project = ?)
        OR (scope = 'brand-kit' AND (owner_project = ? OR owner_workspace = ?))
      )
    ORDER BY scope, name
  `).all(workspaceId, agent.project_id, agent.project_id, workspaceId) as SkillRecord[];

  const overrides = getAgentSkillOverrides(agentId);
  const excluded = new Set(overrides.filter(o => o.mode === "exclude").map(o => o.skill_id));
  const included = overrides.filter(o => o.mode === "include").map(o => o.skill_id);
  const byId = new Map(
    scoped
      .filter(s => !excluded.has(s.id))
      .filter(s => skillMatchesRun(s, queryText))
      .map(s => [s.id, s])
  );

  if (included.length > 0) {
    const placeholders = included.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM skills WHERE id IN (${placeholders}) AND status = 'active'`).all(...included) as SkillRecord[];
    for (const row of rows) byId.set(row.id, row);
  }

  return [...byId.values()];
}
