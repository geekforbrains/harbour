import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createEnvVar,
  createJob,
  createProject,
  createRun,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  const db = freshDb();
  setDb(db);
  initializeSchema(db);
});

afterEach(() => resetDb());

function bindConnection({
  agentId,
  projectId,
  credentialId,
  kind = "openai",
  providerId = "openai",
  baseUrl = null,
  protocol = "native",
}: {
  agentId: string;
  projectId: string;
  credentialId?: string;
  kind?: string;
  providerId?: string;
  baseUrl?: string | null;
  protocol?: string;
}) {
  const db = getDb();
  const id = `connection-${agentId}`;
  db.prepare(
    `INSERT INTO llm_connections
      (id, project_id, name, kind, provider_id, base_url, protocol)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, "Primary provider", kind, providerId, baseUrl, protocol);
  if (credentialId) {
    db.prepare(
      `INSERT INTO llm_connection_secrets (connection_id, role, env_var_id)
       VALUES (?, 'api_key', ?)`,
    ).run(id, credentialId);
  }
  db.prepare(`INSERT INTO agent_llm_connections (agent_id, connection_id) VALUES (?, ?)`).run(
    agentId,
    id,
  );
  return id;
}

describe("OpenCode claim payload", () => {
  it("carries provider metadata and the decrypted key in a private runtime block", () => {
    const project = createProject("Website")!;
    const secret = createEnvVar(project.id, "OPENAI_TEAM_A", "sk-provider-secret")!;
    const agent = createAgent(project.id, "OpenCode", undefined, {
      cli: "opencode",
      model: "openai/gpt-5.1-codex",
      thinking: "high",
    });
    const connectionId = bindConnection({
      agentId: agent.id,
      projectId: project.id,
      credentialId: secret.id,
    });
    // A provider credential remains private even if it was previously pinned
    // or explicitly attached as a normal job Secret.
    getDb().prepare(`UPDATE env_vars SET pinned = 1 WHERE id = ?`).run(secret.id);
    const job = createJob(project.id, agent.id, {
      name: "Build",
      schedule: '{"every":60}',
      envVarIds: [secret.id],
    })!;
    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;

    expect(payload.agent?.provider).toEqual({
      id: connectionId,
      kind: "openai",
      provider_id: "openai",
      base_url: null,
      protocol: "native",
      credential_id: secret.id,
    });
    expect(payload.runtime).toEqual({ llm: { api_key: "sk-provider-secret" } });
    expect(payload.env).not.toHaveProperty("OPENAI_TEAM_A");
    expect(JSON.stringify(payload.agent)).not.toContain("sk-provider-secret");
  });

  it("supports a keyless runner-local Ollama connection", () => {
    const project = createProject("Local Models")!;
    const agent = createAgent(project.id, "Ollama", undefined, {
      cli: "opencode",
      model: "ollama/qwen3-coder:30b",
    });
    bindConnection({
      agentId: agent.id,
      projectId: project.id,
      kind: "ollama",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      protocol: "chat-completions",
    });
    const job = createJob(project.id, agent.id, {
      name: "Local build",
      schedule: '{"every":60}',
    })!;
    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;

    expect(payload.agent?.provider).toMatchObject({
      kind: "ollama",
      provider_id: "ollama",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(payload.runtime).toBeUndefined();
  });

  it("does not add provider runtime data to non-OpenCode agents", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Claude", undefined, {
      cli: "claude",
      model: "sonnet",
    });
    const job = createJob(project.id, agent.id, {
      name: "Build",
      schedule: '{"every":60}',
    })!;
    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;

    expect(payload.agent).not.toHaveProperty("provider");
    expect(payload).not.toHaveProperty("runtime");
  });
});
