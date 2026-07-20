import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "./schema";
import { hashToken } from "./tokens";

function generateApiKey(): string {
  return `hbr_${crypto.randomBytes(32).toString("hex")}`;
}

export function createApiKey(name: string, createdByUserId: string) {
  const db = getDb();
  const id = uuid();
  const apiKey = generateApiKey();
  const apiKeyHash = hashToken(apiKey);
  db.prepare(
    `INSERT INTO api_keys (id, name, api_key_hash, created_by_user_id) VALUES (?, ?, ?, ?)`,
  ).run(id, name, apiKeyHash, createdByUserId);
  return { id, name, apiKey };
}

export function listApiKeys() {
  const db = getDb();
  return db
    .prepare(
      `SELECT k.id, k.name, k.last_used_at, k.created_at, u.display_name as created_by
     FROM api_keys k
     JOIN users u ON k.created_by_user_id = u.id
     ORDER BY k.created_at DESC`,
    )
    .all();
}

/** Delete a key; returns false when no row matched (unknown id). */
export function deleteApiKey(id: string): boolean {
  const db = getDb();
  return db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id).changes > 0;
}

export function authenticateApiKey(apiKey: string) {
  const db = getDb();
  const hash = hashToken(apiKey);
  const row = db
    .prepare(
      `SELECT k.id, k.name, k.created_by_user_id, u.email, u.display_name
     FROM api_keys k
     JOIN users u ON k.created_by_user_id = u.id
     WHERE k.api_key_hash = ?`,
    )
    .get(hash) as any;
  if (row) {
    db.prepare(`UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?`).run(row.id);
  }
  return row || null;
}
