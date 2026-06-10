import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

function generateWorkflowRunnerKey(): string {
  return `hwf_${crypto.randomBytes(32).toString("hex")}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function normalizeLabels(labels?: string[]): string {
  const clean = [...new Set((labels || []).map((l) => l.trim()).filter(Boolean))];
  return JSON.stringify(clean);
}

export function createWorkflowRunner(orgId: string, name: string, opts?: { labels?: string[] }) {
  const db = getDb();
  const id = uuid();
  const apiKey = generateWorkflowRunnerKey();
  const apiKeyHash = hashApiKey(apiKey);
  const labels = normalizeLabels(opts?.labels);

  db.prepare(`
    INSERT INTO workflow_runners (id, org_id, name, api_key_hash, labels)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, orgId, name, apiKeyHash, labels);

  return { id, org_id: orgId, name, labels: JSON.parse(labels), enabled: true, apiKey };
}

export function authenticateWorkflowRunner(apiKey: string) {
  const db = getDb();
  const hash = hashApiKey(apiKey);
  const runner = db
    .prepare(`
    SELECT id, org_id, name, labels, enabled, last_polled_at, created_at, updated_at
    FROM workflow_runners
    WHERE api_key_hash = ? AND enabled = 1
  `)
    .get(hash) as any;
  if (!runner) return null;
  try {
    runner.labels = JSON.parse(runner.labels || "[]");
  } catch {
    runner.labels = [];
  }
  return runner;
}

export function touchWorkflowRunner(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE workflow_runners SET last_polled_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
}

export function listWorkflowRunners(orgId: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT id, org_id, name, labels, enabled, last_polled_at, created_at, updated_at
    FROM workflow_runners
    WHERE org_id = ?
    ORDER BY name
  `)
    .all(orgId)
    .map((r: any) => {
      try {
        return { ...r, labels: JSON.parse(r.labels || "[]") };
      } catch {
        return { ...r, labels: [] };
      }
    });
}
