import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { deleteRunAttachmentsDir } from "./attachments";

function generateApiKey(): string {
  return "hbr_" + crypto.randomBytes(32).toString("hex");
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function createAgent(name: string, description?: string, opts?: {
  type?: string;
  cli?: string;
  model?: string;
  thinking?: string;
  remote?: boolean;
  eager?: boolean;
  scopeType?: "global" | "workspace" | "project";
  workspaceId?: string | null;
  projectId?: string | null;
  composioCliEnabled?: boolean;
  composioMcpEnabled?: boolean;
  composioToolkits?: string[];
  composioTools?: string[];
}) {
  const db = getDb();
  const id = uuid();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const type = opts?.type || "external";
  const cli = opts?.cli || null;
  const model = opts?.model || null;
  const thinking = opts?.thinking || null;
  const remote = opts?.remote ? 1 : 0;
  const eager = opts?.eager ? 1 : 0;
  const scopeType = opts?.scopeType || "global";
  const workspaceId = scopeType === "workspace" ? opts?.workspaceId || null : null;
  const projectId = scopeType === "project" ? opts?.projectId || null : null;
  const composioCliEnabled = opts?.composioCliEnabled ? 1 : 0;
  const composioMcpEnabled = opts?.composioMcpEnabled ? 1 : 0;
  const composioToolkits = opts?.composioToolkits?.length ? JSON.stringify(opts.composioToolkits) : null;
  const composioTools = opts?.composioTools?.length ? JSON.stringify(opts.composioTools) : null;
  db.prepare(
    `INSERT INTO agents (
      id, name, description, api_key_hash, type, cli, model, thinking, remote, eager,
      scope_type, workspace_id, project_id, composio_cli_enabled, composio_mcp_enabled,
      composio_toolkits, composio_tools
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name, description || null, apiKeyHash, type, cli, model, thinking, remote, eager,
    scopeType, workspaceId, projectId, composioCliEnabled, composioMcpEnabled, composioToolkits, composioTools
  );
  if (projectId) {
    db.prepare(`INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(projectId, id);
  }
  return {
    id, name, description, apiKey, type, cli, model, thinking, remote: !!remote, eager: !!eager,
    scope_type: scopeType, workspace_id: workspaceId, project_id: projectId,
    composio_cli_enabled: !!composioCliEnabled,
    composio_mcp_enabled: !!composioMcpEnabled,
    composio_toolkits: opts?.composioToolkits || [],
    composio_tools: opts?.composioTools || [],
  };
}

export function authenticateAgent(apiKey: string) {
  const db = getDb();
  const hash = hashApiKey(apiKey);
  const agent = db.prepare(`SELECT id, name, description FROM agents WHERE api_key_hash = ?`).get(hash) as any;
  return agent || null;
}

export function rotateAgentKey(agentId: string) {
  const db = getDb();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  db.prepare(`UPDATE agents SET api_key_hash = ?, updated_at = unixepoch() WHERE id = ?`).run(apiKeyHash, agentId);
  return apiKey;
}

export function getAgentById(id: string) {
  const db = getDb();
  return db.prepare(`
    SELECT id, name, description, type, cli, model, thinking, remote, eager,
      scope_type, workspace_id, project_id, composio_cli_enabled, composio_mcp_enabled,
      composio_toolkits, composio_tools, last_polled_at, created_at, updated_at
    FROM agents WHERE id = ?
  `).get(id) as any || null;
}

export function listAgents(projectId?: string, workspaceId?: string) {
  const db = getDb();
  if (projectId) {
    const project = db.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(projectId) as { workspace_id: string | null } | undefined;
    const workspaceId = project?.workspace_id || null;
    return db.prepare(`
      SELECT a.id, a.name, a.description, a.type, a.cli, a.model, a.thinking, a.remote, a.eager,
        a.scope_type, a.workspace_id, a.project_id, a.composio_cli_enabled, a.composio_mcp_enabled,
        a.composio_toolkits, a.composio_tools, a.last_polled_at, a.created_at,
        (SELECT COUNT(*) FROM jobs WHERE agent_id = a.id) as job_count,
        (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'waiting') as waiting_count,
        (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'pending') as pending_count,
        (SELECT MAX(created_at) FROM runs WHERE agent_id = a.id) as last_activity
      FROM agents a
      WHERE a.scope_type = 'global'
        OR (a.scope_type = 'workspace' AND a.workspace_id = ?)
        OR (a.scope_type = 'project' AND a.project_id = ?)
        OR a.id IN (SELECT agent_id FROM project_agents WHERE project_id = ?)
      ORDER BY a.name
    `).all(workspaceId, projectId, projectId);
  }
  if (workspaceId) {
    return db.prepare(`
      SELECT a.id, a.name, a.description, a.type, a.cli, a.model, a.thinking, a.remote, a.eager,
        a.scope_type, a.workspace_id, a.project_id, a.composio_cli_enabled, a.composio_mcp_enabled,
        a.composio_toolkits, a.composio_tools, a.last_polled_at, a.created_at,
        (SELECT COUNT(*) FROM jobs WHERE agent_id = a.id) as job_count,
        (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'waiting') as waiting_count,
        (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'pending') as pending_count,
        (SELECT MAX(created_at) FROM runs WHERE agent_id = a.id) as last_activity
      FROM agents a
      WHERE a.scope_type = 'global'
        OR (a.scope_type = 'workspace' AND a.workspace_id = ?)
        OR (a.scope_type = 'project' AND a.project_id IN (SELECT id FROM projects WHERE workspace_id = ?))
        OR a.id IN (
        SELECT pa.agent_id
        FROM project_agents pa
        JOIN projects p ON p.id = pa.project_id
        WHERE p.workspace_id = ?
      )
      ORDER BY a.name
    `).all(workspaceId, workspaceId, workspaceId);
  }
  return db.prepare(`
    SELECT a.id, a.name, a.description, a.type, a.cli, a.model, a.thinking, a.remote, a.eager,
      a.scope_type, a.workspace_id, a.project_id, a.composio_cli_enabled, a.composio_mcp_enabled,
      a.composio_toolkits, a.composio_tools, a.last_polled_at, a.created_at,
      (SELECT COUNT(*) FROM jobs WHERE agent_id = a.id) as job_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'waiting') as waiting_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'pending') as pending_count,
      (SELECT MAX(created_at) FROM runs WHERE agent_id = a.id) as last_activity
    FROM agents a ORDER BY a.name
  `).all();
}

export function updateAgent(id: string, data: { name?: string; description?: string; cli?: string; model?: string; thinking?: string; eager?: boolean }) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description); }
  if (data.cli !== undefined) { fields.push("cli = ?"); values.push(data.cli); }
  if (data.model !== undefined) { fields.push("model = ?"); values.push(data.model); }
  if (data.thinking !== undefined) { fields.push("thinking = ?"); values.push(data.thinking || null); }
  if (data.eager !== undefined) { fields.push("eager = ?"); values.push(data.eager ? 1 : 0); }
  if (fields.length === 0) return getAgentById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgentById(id);
}

export function deleteAgent(id: string) {
  const db = getDb();
  // Capture run ids first so we can clean their on-disk attachment dirs after cascade
  const runIds = db.prepare(`SELECT id FROM runs WHERE agent_id = ?`).all(id) as { id: string }[];
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  for (const r of runIds) deleteRunAttachmentsDir(r.id);
}

export function touchAgentPolled(id: string) {
  const db = getDb();
  db.prepare(`UPDATE agents SET last_polled_at = unixepoch() WHERE id = ?`).run(id);
}
