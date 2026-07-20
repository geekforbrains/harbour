import { v4 as uuid } from "uuid";
import { InvalidNameError, NameCollisionError, slugify } from "../slug";
import { deleteRunAttachmentsDir } from "./attachments";
import { getDb, isUniqueViolation } from "./schema";

function agentCollisionError(existingName: string, slug: string) {
  return new NameCollisionError(
    `An agent named "${existingName}" already exists in this project (folder name "${slug}") — ` +
      `names must be unique ignoring case and punctuation.`,
  );
}

export function createAgent(
  projectId: string,
  name: string,
  description?: string,
  opts?: {
    cli?: string;
    model?: string;
    thinking?: string;
    color?: string;
    eager?: boolean;
    placement?: string;
  },
) {
  const db = getDb();
  const slug = slugify(name);
  if (!slug) {
    throw new InvalidNameError("Agent name must contain at least one letter or number.");
  }
  // Slugs are unique per project (the agent's workspace directory name).
  const existing = db
    .prepare(`SELECT name FROM agents WHERE project_id = ? AND slug = ?`)
    .get(projectId, slug) as { name: string } | undefined;
  if (existing) throw agentCollisionError(existing.name, slug);
  const id = uuid();
  const cli = opts?.cli || null;
  const model = opts?.model || null;
  const thinking = opts?.thinking || null;
  const color = opts?.color || null;
  const eager = opts?.eager ? 1 : 0;
  const placement = opts?.placement?.trim() || "local";
  try {
    db.prepare(
      `INSERT INTO agents (id, project_id, name, slug, description, cli, model, thinking, color, eager, placement)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      name,
      slug,
      description || null,
      cli,
      model,
      thinking,
      color,
      eager,
      placement,
    );
  } catch (err) {
    // Race backstop: a concurrent create can slip past the pre-check; the
    // unique index catches it.
    if (isUniqueViolation(err)) {
      const winner = db
        .prepare(`SELECT name FROM agents WHERE project_id = ? AND slug = ?`)
        .get(projectId, slug) as { name: string } | undefined;
      throw agentCollisionError(winner?.name ?? name, slug);
    }
    throw err;
  }
  return {
    id,
    project_id: projectId,
    name,
    slug,
    description,
    cli,
    model,
    thinking,
    color,
    eager: !!eager,
    placement,
  };
}

export function getAgentById(id: string) {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT id, project_id, name, slug, description, cli, model, thinking, color, eager, placement, created_at, updated_at
     FROM agents WHERE id = ?`,
      )
      .get(id) as any) || null
  );
}

/**
 * Workspace path segments for an agent — the stored project/agent slugs, read
 * live so the workspace always reflects the current hierarchy. Identity
 * segments only, never absolute paths: the runner owns its filesystem layout
 * (it may be a different machine).
 */
export function getAgentWorkspace(agentId: string) {
  const db = getDb();
  return (
    (db
      .prepare(`
        SELECT p.slug AS project, a.slug AS agent
        FROM agents a
        JOIN projects p ON a.project_id = p.id
        WHERE a.id = ?
      `)
      .get(agentId) as { project: string; agent: string } | undefined) || null
  );
}

/** List agents — one project's when projectId is given, all projects' otherwise. */
export function listAgents(projectId?: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT a.id, a.project_id, p.name as project_name, a.name, a.slug, a.description, a.cli, a.model, a.thinking, a.color, a.eager, a.placement, a.created_at,
      (SELECT COUNT(*) FROM jobs WHERE agent_id = a.id) as job_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'waiting') as waiting_count,
      (SELECT COUNT(*) FROM runs WHERE agent_id = a.id AND status = 'pending') as pending_count,
      (SELECT MAX(created_at) FROM runs WHERE agent_id = a.id) as last_activity
    FROM agents a
    JOIN projects p ON a.project_id = p.id
    ${projectId ? "WHERE a.project_id = ?" : ""}
    ORDER BY a.name
  `)
    .all(...(projectId ? [projectId] : []));
}

export function updateAgent(
  id: string,
  data: {
    name?: string;
    description?: string;
    cli?: string;
    model?: string;
    thinking?: string;
    color?: string;
    eager?: boolean;
    placement?: string;
  },
) {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) {
    // Rename never touches the slug — workspace paths stay stable.
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.cli !== undefined) {
    fields.push("cli = ?");
    values.push(data.cli);
  }
  if (data.model !== undefined) {
    fields.push("model = ?");
    values.push(data.model);
  }
  if (data.thinking !== undefined) {
    fields.push("thinking = ?");
    values.push(data.thinking || null);
  }
  if (data.color !== undefined) {
    fields.push("color = ?");
    values.push(data.color || null);
  }
  if (data.eager !== undefined) {
    fields.push("eager = ?");
    values.push(data.eager ? 1 : 0);
  }
  if (data.placement !== undefined) {
    fields.push("placement = ?");
    values.push(data.placement.trim() || "local");
  }
  if (fields.length === 0) return getAgentById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgentById(id);
}

export function deleteAgent(id: string) {
  const db = getDb();
  // Capture run ids first so we can clean their on-disk attachment dirs after
  // cascade. Includes runs reachable via the agent's jobs (jobs.agent_id
  // CASCADE deletes them too) — not just runs that still point at the agent,
  // since runs.agent_id may already be SET NULL.
  const runIds = db
    .prepare(
      `SELECT id FROM runs WHERE agent_id = ? OR job_id IN (SELECT id FROM jobs WHERE agent_id = ?)`,
    )
    .all(id, id) as { id: string }[];
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  for (const r of runIds) deleteRunAttachmentsDir(r.id);
}
