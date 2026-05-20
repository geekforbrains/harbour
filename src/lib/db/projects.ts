import { getDb } from "./schema";
import { v4 as uuid } from "uuid";

export type ProjectRecord = {
  id: string;
  workspace_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
};

// --- Project CRUD ---

export function createProject(name: string, workspaceId?: string | null): ProjectRecord | null {
  const db = getDb();
  const id = uuid();
  const ownerWorkspaceId = workspaceId || "borg-interface";
  db.prepare(`INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, ?)`).run(id, ownerWorkspaceId, name);
  return getProjectById(id);
}

export function getProjectById(id: string): ProjectRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRecord | undefined;
  return row || null;
}

export function listProjects(workspaceId?: string): ProjectRecord[] {
  const db = getDb();
  if (workspaceId) {
    return db.prepare(`SELECT * FROM projects WHERE workspace_id = ? ORDER BY name ASC`).all(workspaceId) as ProjectRecord[];
  }
  return db.prepare(`SELECT * FROM projects ORDER BY name ASC`).all() as ProjectRecord[];
}

export function updateProject(id: string, data: { name?: string; workspace_id?: string | null }): ProjectRecord | null {
  const db = getDb();
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.workspace_id !== undefined) { fields.push("workspace_id = ?"); values.push(data.workspace_id); }
  if (fields.length === 0) return getProjectById(id);
  fields.push("updated_at = unixepoch()");
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

export function deleteProject(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

// --- Linking: Agents ---

export function linkAgentToProject(projectId: string, agentId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(projectId, agentId);
}

export function unlinkAgentFromProject(projectId: string, agentId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`).run(projectId, agentId);
}

export function listAgentIdsForProject(projectId: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT agent_id FROM project_agents WHERE project_id = ?`).all(projectId) as { agent_id: string }[]).map(r => r.agent_id);
}

// --- Linking: Jobs ---

export function linkJobToProject(projectId: string, jobId: string) {
  const db = getDb();

  db.transaction(() => {
    // Link the job itself
    db.prepare(`INSERT OR IGNORE INTO project_jobs (project_id, job_id) VALUES (?, ?)`).run(projectId, jobId);

    // Auto-link the job's agent
    const job = db.prepare(`SELECT agent_id FROM jobs WHERE id = ?`).get(jobId) as { agent_id: string } | undefined;
    if (job) {
      db.prepare(`INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?, ?)`).run(projectId, job.agent_id);
    }

    // Auto-link the job's docs
    const docs = db.prepare(`SELECT doc_id FROM job_docs WHERE job_id = ?`).all(jobId) as { doc_id: string }[];
    for (const d of docs) {
      db.prepare(`INSERT OR IGNORE INTO project_docs (project_id, doc_id) VALUES (?, ?)`).run(projectId, d.doc_id);
    }

    // Auto-link the job's env vars
    const envVars = db.prepare(`SELECT env_var_id FROM job_env_vars WHERE job_id = ?`).all(jobId) as { env_var_id: string }[];
    for (const ev of envVars) {
      db.prepare(`INSERT OR IGNORE INTO project_env_vars (project_id, env_var_id) VALUES (?, ?)`).run(projectId, ev.env_var_id);
    }

    // Auto-link the job's databases
    const databases = db.prepare(`SELECT database_id FROM job_databases WHERE job_id = ?`).all(jobId) as { database_id: string }[];
    for (const d of databases) {
      db.prepare(`INSERT OR IGNORE INTO project_databases (project_id, database_id) VALUES (?, ?)`).run(projectId, d.database_id);
    }
  })();
}

export function unlinkJobFromProject(projectId: string, jobId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM project_jobs WHERE project_id = ? AND job_id = ?`).run(projectId, jobId);
}

export function listJobIdsForProject(projectId: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT job_id FROM project_jobs WHERE project_id = ?`).all(projectId) as { job_id: string }[]).map(r => r.job_id);
}

// --- Linking: Docs ---

export function linkDocToProject(projectId: string, docId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO project_docs (project_id, doc_id) VALUES (?, ?)`).run(projectId, docId);
}

export function unlinkDocFromProject(projectId: string, docId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM project_docs WHERE project_id = ? AND doc_id = ?`).run(projectId, docId);
}

export function listDocIdsForProject(projectId: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT doc_id FROM project_docs WHERE project_id = ?`).all(projectId) as { doc_id: string }[]).map(r => r.doc_id);
}

// --- Linking: Env Vars ---

export function linkEnvVarToProject(projectId: string, envVarId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO project_env_vars (project_id, env_var_id) VALUES (?, ?)`).run(projectId, envVarId);
}

export function unlinkEnvVarFromProject(projectId: string, envVarId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM project_env_vars WHERE project_id = ? AND env_var_id = ?`).run(projectId, envVarId);
}

export function listEnvVarIdsForProject(projectId: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT env_var_id FROM project_env_vars WHERE project_id = ?`).all(projectId) as { env_var_id: string }[]).map(r => r.env_var_id);
}

// --- Linking: Databases ---

export function linkDatabaseToProject(projectId: string, databaseId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO project_databases (project_id, database_id) VALUES (?, ?)`).run(projectId, databaseId);
}

export function unlinkDatabaseFromProject(projectId: string, databaseId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM project_databases WHERE project_id = ? AND database_id = ?`).run(projectId, databaseId);
}

export function listDatabaseIdsForProject(projectId: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT database_id FROM project_databases WHERE project_id = ?`).all(projectId) as { database_id: string }[]).map(r => r.database_id);
}
