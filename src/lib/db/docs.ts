import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

/**
 * Create a doc. Dual-tier: pass projectId for a project-level doc, or omit it
 * (null) for an org-level doc shared across the org's projects.
 */
export function createDoc(
  orgId: string,
  projectId: string | null,
  title: string,
  content?: string,
  authorType?: string,
  authorId?: string,
) {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO docs (id, org_id, project_id, title, created_by_type, created_by_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, orgId, projectId, title, authorType || null, authorId || null);

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

  const revision = db
    .prepare(`SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1`)
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

/**
 * Two-tier list: org-level docs (project_id IS NULL) plus the given project's
 * docs. Pass projectId=null to list only org-level docs.
 */
export function listDocs(orgId: string, projectId: string | null = null) {
  const db = getDb();
  const projectFilter = projectId
    ? "AND (d.project_id = ? OR d.project_id IS NULL)"
    : "AND d.project_id IS NULL";
  const params = projectId ? [orgId, projectId] : [orgId];
  return db
    .prepare(`
    SELECT d.id, d.title, d.org_id, d.project_id, d.pinned, d.created_at, d.updated_at,
      (SELECT COUNT(*) FROM doc_revisions WHERE doc_id = d.id) as revision_count
    FROM docs d
    WHERE d.org_id = ? ${projectFilter}
    ORDER BY d.pinned DESC, d.title ASC
  `)
    .all(...params);
}

export function toggleDocPinned(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE docs SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
  return getDocById(id);
}

/**
 * Docs injected into a job's run payload (used by buildRunPayload / the runner claim payload).
 *
 * Injection is attachment-driven: only docs explicitly linked to the job via
 * `job_docs` are returned — never the org/project tiers at large. Links are
 * created explicitly at job create/update (the dashboard pre-selects pinned
 * docs as a creation-time default). Each doc carries the content of its latest
 * revision. Returned shape matches the agent contract: `{ id, title, content }`.
 */
export function getComposedDocsForJob(
  jobId: string,
): { id: string; title: string; content: string }[] {
  const db = getDb();

  return db
    .prepare(`
    SELECT d.id, d.title, dr.content
    FROM job_docs jd
    JOIN docs d ON d.id = jd.doc_id
    LEFT JOIN doc_revisions dr ON dr.doc_id = d.id
      AND dr.created_at = (SELECT MAX(created_at) FROM doc_revisions WHERE doc_id = d.id)
    WHERE jd.job_id = ?
    ORDER BY d.title ASC
  `)
    .all(jobId) as {
    id: string;
    title: string;
    content: string;
  }[];
}

export function getDocRevisions(docId: string) {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC`)
    .all(docId);
}
