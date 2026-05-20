import { getDb } from "./schema";
import { v4 as uuid } from "uuid";

export function createDoc(title: string, content?: string, authorType?: string, authorId?: string) {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO docs (id, title, created_by_type, created_by_id) VALUES (?, ?, ?, ?)`
  ).run(id, title, authorType || null, authorId || null);

  if (content) {
    const revId = uuid();
    db.prepare(
      `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id) VALUES (?, ?, ?, ?, ?)`
    ).run(revId, id, content, authorType || null, authorId || null);
  }

  return getDocById(id);
}

export function getDocById(id: string) {
  const db = getDb();
  const doc = db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as any;
  if (!doc) return null;

  const revision = db.prepare(
    `SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(id) as any;

  return { ...doc, content: revision?.content || "", last_revision: revision };
}

export function updateDoc(docId: string, content: string, authorType: string, authorId: string) {
  const db = getDb();
  const revId = uuid();
  db.prepare(
    `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id) VALUES (?, ?, ?, ?, ?)`
  ).run(revId, docId, content, authorType, authorId);
  db.prepare(`UPDATE docs SET updated_at = unixepoch() WHERE id = ?`).run(docId);
  return getDocById(docId);
}

export function renameDoc(docId: string, title: string) {
  const db = getDb();
  db.prepare(`UPDATE docs SET title = ?, updated_at = unixepoch() WHERE id = ?`).run(title, docId);
  return getDocById(docId);
}

export function deleteDoc(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM docs WHERE id = ?`).run(id);
}

export function listDocs(projectId?: string, workspaceId?: string) {
  const db = getDb();
  if (projectId) {
    return db.prepare(`
      SELECT d.id, d.title, d.pinned, d.created_at, d.updated_at,
        (SELECT COUNT(*) FROM doc_revisions WHERE doc_id = d.id) as revision_count
      FROM docs d
      WHERE d.id IN (SELECT doc_id FROM project_docs WHERE project_id = ?)
      ORDER BY d.pinned DESC, d.title ASC
    `).all(projectId);
  }
  if (workspaceId) {
    return db.prepare(`
      SELECT d.id, d.title, d.pinned, d.created_at, d.updated_at,
        (SELECT COUNT(*) FROM doc_revisions WHERE doc_id = d.id) as revision_count
      FROM docs d
      WHERE d.id IN (
        SELECT pd.doc_id
        FROM project_docs pd
        JOIN projects p ON p.id = pd.project_id
        WHERE p.workspace_id = ?
      )
      ORDER BY d.pinned DESC, d.title ASC
    `).all(workspaceId);
  }
  return db.prepare(`
    SELECT d.id, d.title, d.pinned, d.created_at, d.updated_at,
      (SELECT COUNT(*) FROM doc_revisions WHERE doc_id = d.id) as revision_count
    FROM docs d
    ORDER BY d.pinned DESC, d.title ASC
  `).all();
}

export function toggleDocPinned(id: string) {
  const db = getDb();
  db.prepare(`UPDATE docs SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`).run(id);
  return getDocById(id);
}

export function listPinnedDocIds(): string[] {
  const db = getDb();
  return (db.prepare(`SELECT id FROM docs WHERE pinned = 1`).all() as { id: string }[]).map(r => r.id);
}

export function getDocRevisions(docId: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC`).all(docId);
}
