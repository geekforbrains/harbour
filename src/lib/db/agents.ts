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

export function createAgent(projectId: string, name: string, description?: string, opts?: {
  cli?: string;
  model?: string;
  thinking?: string;
  color?: string;
  eager?: boolean;
}) {
  const db = getDb();
  const id = uuid();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const cli = opts?.cli || null;
  const model = opts?.model || null;
  const thinking = opts?.thinking || null;
  const color = opts?.color || null;
  const eager = opts?.eager ? 1 : 0;
  db.prepare(
    `INSERT INTO agents (id, project_id, name, description, api_key_hash, cli, model, thinking, color, eager)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, name, description || null, apiKeyHash, cli, model, thinking, color, eager);
  return { id, project_id: projectId, name, description, apiKey, cli, model, thinking, color, eager: !!eager };
}

export function authenticateAgent(apiKey: string) {
  const db = getDb();
  const hash = hashApiKey(apiKey);
  const agent = db.prepare(
    `SELECT id, project_id, name, description FROM agents WHERE api_key_hash = ?`
  ).get(hash) as any;
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
  return db.prepare(
    `SELECT id, project_id, name, description, cli, model, thinking, color, eager, runner_fingerprint, last_polled_at, created_at, updated_at
     FROM agents WHERE id = ?`
  ).get(id) as any || null;
}

export function listAgents(projectId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.project_id, a.name, a.description, a.cli, a.model, a.thinking, a.color, a.eager, a.last_polled_at, a.created_at,
      (SELECT COUNT(*) FROM jobs WHERE agent_id = a.id) as job_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'waiting') as waiting_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'pending') as pending_count,
      (SELECT MAX(created_at) FROM runs WHERE agent_id = a.id) as last_activity
    FROM agents a
    WHERE a.project_id = ?
    ORDER BY a.name
  `).all(projectId);
}

export function updateAgent(id: string, data: {
  name?: string;
  description?: string;
  cli?: string;
  model?: string;
  thinking?: string;
  color?: string;
  eager?: boolean;
}) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description); }
  if (data.cli !== undefined) { fields.push("cli = ?"); values.push(data.cli); }
  if (data.model !== undefined) { fields.push("model = ?"); values.push(data.model); }
  if (data.thinking !== undefined) { fields.push("thinking = ?"); values.push(data.thinking || null); }
  if (data.color !== undefined) { fields.push("color = ?"); values.push(data.color || null); }
  if (data.eager !== undefined) { fields.push("eager = ?"); values.push(data.eager ? 1 : 0); }
  if (fields.length === 0) return getAgentById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgentById(id);
}

/**
 * Record the runner fingerprint that first claimed this agent (one-runtime-
 * per-agent guard). Returns true if accepted (matched or first set), false if
 * a different fingerprint already owns the agent.
 */
export function claimAgentRunner(id: string, fingerprint: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT runner_fingerprint FROM agents WHERE id = ?`).get(id) as
    | { runner_fingerprint: string | null }
    | undefined;
  if (!row) return false;
  if (row.runner_fingerprint && row.runner_fingerprint !== fingerprint) return false;
  if (!row.runner_fingerprint) {
    db.prepare(`UPDATE agents SET runner_fingerprint = ?, updated_at = unixepoch() WHERE id = ?`).run(fingerprint, id);
  }
  return true;
}

/** Clear the runner fingerprint (admin clicks Reconnect to migrate runtimes). */
export function resetAgentRunner(id: string) {
  const db = getDb();
  db.prepare(`UPDATE agents SET runner_fingerprint = NULL, updated_at = unixepoch() WHERE id = ?`).run(id);
}

export function deleteAgent(id: string) {
  const db = getDb();
  // Capture run ids first so we can clean their on-disk attachment dirs after
  // cascade. Includes runs reachable via the agent's jobs (jobs.agent_id
  // CASCADE deletes them too) — not just runs that still point at the agent,
  // since runs.agent_id may already be SET NULL.
  const runIds = db.prepare(
    `SELECT id FROM runs WHERE agent_id = ? OR job_id IN (SELECT id FROM jobs WHERE agent_id = ?)`
  ).all(id, id) as { id: string }[];
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  for (const r of runIds) deleteRunAttachmentsDir(r.id);
}

export function touchAgentPolled(id: string) {
  const db = getDb();
  db.prepare(`UPDATE agents SET last_polled_at = unixepoch() WHERE id = ?`).run(id);
}
