import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

export function createDoc(
  projectId: string,
  title: string,
  content?: string,
  authorType?: string,
  authorId?: string,
) {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO docs (id, project_id, title, created_by_type, created_by_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, projectId, title, authorType || null, authorId || null);

  if (content) {
    const revId = uuid();
    db.prepare(
      `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(revId, id, content, authorType || null, authorId || null);
  }

  return getDocById(id);
}

export function getDocById(id: string) {
  const db = getDb();
  const doc = db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as any;
  if (!doc) return null;

  // created_at is integer seconds, so two revisions written in the same wall
  // clock second tie; rowid (monotonic insert order) breaks the tie so the
  // newest revision always wins rather than SQLite's arbitrary tie order.
  const revision = db
    .prepare(
      `SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id) as any;

  return { ...doc, content: revision?.content || "", last_revision: revision };
}

export function updateDoc(docId: string, content: string, authorType: string, authorId: string) {
  const db = getDb();
  const revId = uuid();
  db.prepare(
    `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id) VALUES (?, ?, ?, ?, ?)`,
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

/** List docs — one project's when projectId is given, all projects' otherwise. */
export function listDocs(projectId?: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT d.id, d.title, d.project_id, p.name as project_name, d.pinned, d.created_at, d.updated_at,
      (SELECT COUNT(*) FROM doc_revisions WHERE doc_id = d.id) as revision_count
    FROM docs d
    JOIN projects p ON d.project_id = p.id
    ${projectId ? "WHERE d.project_id = ?" : ""}
    ORDER BY d.pinned DESC, d.title ASC
  `)
    .all(...(projectId ? [projectId] : []));
}

export function toggleDocPinned(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE docs SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
  return getDocById(id);
}

/**
 * Docs injected into a job's run payload (used by buildRunPayload / the runner
 * claim payload): pinned docs from the job's own project first, then docs
 * explicitly linked via `job_docs` (any project) in link-creation order. A doc
 * that is both pinned and linked appears once. Each doc carries the content of
 * its latest revision. Returned shape matches the agent contract:
 * `{ id, title, content }`.
 */
export function getComposedDocsForJob(
  jobId: string,
): { id: string; title: string; content: string }[] {
  const db = getDb();
  type Row = { id: string; title: string; content: string };

  const latestRevision = `
    LEFT JOIN doc_revisions dr ON dr.rowid = (
      SELECT rowid FROM doc_revisions WHERE doc_id = d.id
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    )`;
  // COALESCE: a doc created without content has zero revisions; match
  // getDocById's empty-string fallback so content is always a string on the wire.
  const pinned = db
    .prepare(`
    SELECT d.id, d.title, COALESCE(dr.content, '') as content
    FROM docs d
    ${latestRevision}
    WHERE d.pinned = 1 AND d.project_id = (SELECT project_id FROM jobs WHERE id = ?)
    ORDER BY d.title ASC
  `)
    .all(jobId) as Row[];
  const linked = db
    .prepare(`
    SELECT d.id, d.title, COALESCE(dr.content, '') as content
    FROM job_docs jd
    JOIN docs d ON d.id = jd.doc_id
    ${latestRevision}
    WHERE jd.job_id = ?
    ORDER BY jd.rowid ASC
  `)
    .all(jobId) as Row[];

  const byId = new Map<string, Row>();
  for (const doc of [...pinned, ...linked]) byId.set(doc.id, doc);
  return [...byId.values()];
}

export function getDocRevisions(docId: string) {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(docId);
}
