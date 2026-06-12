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
 * Pinned doc ids for the given scope (org-level + the project's pinned docs).
 * Used to auto-attach pinned docs to new jobs created in a project.
 */
export function listPinnedDocIds(projectId: string): string[] {
  const db = getDb();
  // Resolve the org from the project so org-level pinned docs are included.
  const proj = db.prepare(`SELECT org_id FROM projects WHERE id = ?`).get(projectId) as
    | { org_id: string }
    | undefined;
  if (!proj) return [];
  return (
    db
      .prepare(
        `SELECT id FROM docs WHERE pinned = 1 AND org_id = ? AND (project_id = ? OR project_id IS NULL)`,
      )
      .all(proj.org_id, projectId) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Composed docs for a job's run payload (used by /next).
 *
 * Composition (per the v2 resource model) = all org-level docs of the job's org
 * + all project-level docs of the job's project + the job's explicitly linked
 * docs, de-duplicated by id (a doc that is both at-tier and job-linked appears
 * once). Each doc carries the content of its latest revision. An org-level job
 * (project_id NULL) has no project tier — the project-tier branch's
 * `project_id = NULL` matches nothing — so it composes org-tier + job-linked.
 *
 * Docs have no name/key, so there is no value-override on collision — only
 * id de-duplication. Returned shape matches the agent contract:
 * `{ id, title, content }`.
 */
export function getComposedDocsForJob(
  jobId: string,
): { id: string; title: string; content: string }[] {
  const db = getDb();

  const scope = db.prepare(`SELECT org_id, project_id FROM jobs WHERE id = ?`).get(jobId) as
    | { org_id: string; project_id: string | null }
    | undefined;
  if (!scope) return [];

  // Union of org-level + project-level + job-linked doc ids for this job, then
  // resolve each to its latest-revision content. DISTINCT de-dups ids that
  // appear in more than one tier.
  return db
    .prepare(`
    SELECT d.id, d.title, dr.content
    FROM docs d
    LEFT JOIN doc_revisions dr ON dr.doc_id = d.id
      AND dr.created_at = (SELECT MAX(created_at) FROM doc_revisions WHERE doc_id = d.id)
    WHERE d.id IN (
      SELECT id FROM docs WHERE org_id = ? AND project_id IS NULL
      UNION
      SELECT id FROM docs WHERE org_id = ? AND project_id = ?
      UNION
      SELECT doc_id FROM job_docs WHERE job_id = ?
    )
    ORDER BY d.title ASC
  `)
    .all(scope.org_id, scope.org_id, scope.project_id, jobId) as {
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
