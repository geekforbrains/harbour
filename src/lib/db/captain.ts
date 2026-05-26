import crypto from "crypto";
import { getDb } from "./schema";

// ── Types ──────────────────────────────────────────────────────────────

export type CaptainConversation = {
  id: string;
  org_id: string;
  title: string;
  cli: string;
  model: string | null;
  thinking: string | null;
  session_id: string | null;
  cwd: string | null;
  user_id: string;
  created_at: number;
  updated_at: number;
};

export type CaptainMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
};

export type CaptainOutputEvent = {
  id: number;
  conversation_id: string;
  message_id: string | null;
  event_type: string;
  content: string | null;
  tool_name: string | null;
  created_at: number;
};

// ── Conversations ──────────────────────────────────────────────────────

/** List conversations for a user within an org (Captain is per-org). */
export function listConversations(orgId: string, userId: string): CaptainConversation[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM captain_conversations WHERE org_id = ? AND user_id = ? ORDER BY updated_at DESC`
    )
    .all(orgId, userId) as CaptainConversation[];
}

export function getConversation(
  id: string,
  orgId?: string
): CaptainConversation | undefined {
  const db = getDb();
  // Captain is per-org; when a caller knows the org, scope by it so a bare id
  // can't surface another org's conversation (consistent with list/create).
  if (orgId) {
    return db
      .prepare(`SELECT * FROM captain_conversations WHERE id = ? AND org_id = ?`)
      .get(id, orgId) as CaptainConversation | undefined;
  }
  return db
    .prepare(`SELECT * FROM captain_conversations WHERE id = ?`)
    .get(id) as CaptainConversation | undefined;
}

export function createConversation(
  orgId: string,
  title: string,
  cli: string,
  model: string | null,
  thinking: string | null,
  cwd: string | null,
  userId: string
): CaptainConversation {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO captain_conversations (id, org_id, title, cli, model, thinking, cwd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, title, cli, model || null, thinking || null, cwd || null, userId);
  return getConversation(id)!;
}

export function updateConversation(
  id: string,
  updates: Partial<
    Pick<CaptainConversation, "title" | "session_id" | "updated_at">
  >
) {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.title !== undefined) {
    sets.push("title = ?");
    vals.push(updates.title);
  }
  if (updates.session_id !== undefined) {
    sets.push("session_id = ?");
    vals.push(updates.session_id);
  }
  sets.push("updated_at = unixepoch()");
  vals.push(id);

  db.prepare(
    `UPDATE captain_conversations SET ${sets.join(", ")} WHERE id = ?`
  ).run(...vals);
}

export function deleteConversation(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM captain_conversations WHERE id = ?`).run(id);
}

// ── Messages ───────────────────────────────────────────────────────────

export function listMessages(conversationId: string): CaptainMessage[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM captain_messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as CaptainMessage[];
}

export function createMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string = ""
): CaptainMessage {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO captain_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`
  ).run(id, conversationId, role, content);
  db.prepare(
    `UPDATE captain_conversations SET updated_at = unixepoch() WHERE id = ?`
  ).run(conversationId);
  return db
    .prepare(`SELECT * FROM captain_messages WHERE id = ?`)
    .get(id) as CaptainMessage;
}

export function updateMessageContent(id: string, content: string) {
  const db = getDb();
  db.prepare(`UPDATE captain_messages SET content = ? WHERE id = ?`).run(
    content,
    id
  );
}

// ── Output (streaming events) ──────────────────────────────────────────

export function addCaptainOutput(
  conversationId: string,
  messageId: string,
  events: { event_type: string; content: string | null; tool_name: string | null }[]
) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO captain_output (conversation_id, message_id, event_type, content, tool_name) VALUES (?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction(
    (evts: typeof events) => {
      for (const e of evts) {
        stmt.run(conversationId, messageId, e.event_type, e.content, e.tool_name);
      }
    }
  );
  insertMany(events);
}

export function listCaptainOutput(
  conversationId: string,
  afterId: number = 0,
  messageId?: string
): CaptainOutputEvent[] {
  const db = getDb();
  if (messageId) {
    return db
      .prepare(
        `SELECT * FROM captain_output WHERE conversation_id = ? AND message_id = ? AND id > ? ORDER BY id ASC`
      )
      .all(conversationId, messageId, afterId) as CaptainOutputEvent[];
  }
  return db
    .prepare(
      `SELECT * FROM captain_output WHERE conversation_id = ? AND id > ? ORDER BY id ASC`
    )
    .all(conversationId, afterId) as CaptainOutputEvent[];
}

export function listToolEventsByMessage(messageId: string): CaptainOutputEvent[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM captain_output WHERE message_id = ? AND event_type IN ('tool_start', 'tool_end') ORDER BY id ASC`
    )
    .all(messageId) as CaptainOutputEvent[];
}

export function deleteCaptainOutput(conversationId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM captain_output WHERE conversation_id = ?`).run(
    conversationId
  );
}
