import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { PUT as agentPUT } from "@/app/api/agents/[id]/route";
import { POST as agentsPOST } from "@/app/api/agents/route";
import { DELETE as envVarDELETE } from "@/app/api/env-vars/[id]/route";
import { PUT as jobPUT } from "@/app/api/jobs/[id]/route";
import {
  DELETE as connectionDELETE,
  GET as connectionGET,
  PUT as connectionPUT,
} from "@/app/api/llm-connections/[id]/route";
import { GET as connectionsGET, POST as connectionsPOST } from "@/app/api/llm-connections/route";
import {
  bindAgentToLlmConnection,
  createAgent,
  createEnvVar,
  createJob,
  createLlmConnection,
  createProject,
  createSession,
  createUser,
  deleteLlmConnection,
  deleteProject,
  getAgentById,
  getEnvVarById,
  getLlmConnectionRuntimeForAgent,
  listLlmConnections,
  unbindAgentFromLlmConnection,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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

let seq = 0;

function userReq(url: string, method: string, body?: unknown): NextRequest {
  const user = createUser(`llm-${seq++}@example.test`, "pw", "User")!;
  const sessionId = createSession(user.id);
  const headers = new Headers({ cookie: `harbour_session=${sessionId}` });
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

describe("LLM connection domain", () => {
  it("creates an encrypted credential transactionally and returns metadata only", () => {
    const project = createProject("Website")!;
    const connection = createLlmConnection(project.id, {
      name: "OpenAI production",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credential: { name: "OPENAI_PROD", value: "sk-never-return-this" },
    });

    expect(connection).toMatchObject({
      project_id: project.id,
      name: "OpenAI production",
      kind: "openai",
      provider_id: "openai",
      base_url: null,
      protocol: "native",
      credential: { name: "OPENAI_PROD" },
    });
    expect(JSON.stringify(connection)).not.toContain("sk-never-return-this");

    const agent = createAgent(project.id, "Builder", undefined, {
      cli: "opencode",
      model: "openai/gpt-5",
    });
    bindAgentToLlmConnection(agent.id, connection.id);
    expect(getLlmConnectionRuntimeForAgent(agent.id)).toMatchObject({
      id: connection.id,
      provider_id: "openai",
      api_key: "sk-never-return-this",
    });
  });

  it("rolls back the connection when nested Secret creation fails", () => {
    const project = createProject("Website")!;
    createEnvVar(project.id, "OPENAI_KEY", "first");

    expect(() =>
      createLlmConnection(project.id, {
        name: "Will roll back",
        kind: "openai",
        providerId: "openai",
        protocol: "native",
        credential: { name: "OPENAI_KEY", value: "second" },
      }),
    ).toThrow(/already exists/);
    expect(listLlmConnections(project.id)).toEqual([]);
  });

  it("rejects cross-project credentials and agent bindings", () => {
    const first = createProject("First")!;
    const second = createProject("Second")!;
    const foreignSecret = createEnvVar(second.id, "FOREIGN_KEY", "secret")!;

    expect(() =>
      createLlmConnection(first.id, {
        name: "Bad credential",
        kind: "openai",
        providerId: "openai",
        protocol: "native",
        credentialId: foreignSecret.id,
      }),
    ).toThrow(/same project/i);

    const localSecret = createEnvVar(first.id, "LOCAL_KEY", "secret")!;
    const connection = createLlmConnection(first.id, {
      name: "First OpenAI",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: localSecret.id,
    });
    const foreignAgent = createAgent(second.id, "Builder", undefined, { cli: "opencode" });
    expect(() => bindAgentToLlmConnection(foreignAgent.id, connection.id)).toThrow(/same project/i);
  });

  it("guards connection and Secret deletion while they are in use", async () => {
    const project = createProject("Website")!;
    const secret = createEnvVar(project.id, "OPENAI_KEY", "secret")!;
    const connection = createLlmConnection(project.id, {
      name: "OpenAI",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: secret.id,
    });
    const agent = createAgent(project.id, "Builder", undefined, { cli: "opencode" });
    bindAgentToLlmConnection(agent.id, connection.id);

    expect(() => deleteLlmConnection(connection.id)).toThrow(/in use/i);

    const secretDelete = await envVarDELETE(
      userReq(`http://x/api/env-vars/${secret.id}`, "DELETE"),
      ctx({ id: secret.id }),
    );
    expect(secretDelete.status).toBe(409);
    expect(getEnvVarById(secret.id)).not.toBeNull();

    unbindAgentFromLlmConnection(agent.id);
    expect(deleteLlmConnection(connection.id)).toBe(true);
    expect(getEnvVarById(secret.id)).not.toBeNull();
  });

  it("cascades a project through a bound agent, connection, and credential", () => {
    const project = createProject("Disposable")!;
    const secret = createEnvVar(project.id, "OPENAI_KEY", "secret")!;
    const connection = createLlmConnection(project.id, {
      name: "OpenAI",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: secret.id,
    });
    const agent = createAgent(project.id, "Builder", undefined, {
      cli: "opencode",
      model: "openai/gpt-5",
      llmConnectionId: connection.id,
    });

    expect(() => deleteProject(project.id)).not.toThrow();
    expect(listLlmConnections(project.id)).toEqual([]);
    expect(getEnvVarById(secret.id)).toBeNull();
    expect(getLlmConnectionRuntimeForAgent(agent.id)).toBeNull();
  });
});

describe("LLM connection API", () => {
  it("creates, lists, gets, and updates metadata without exposing a key", async () => {
    const project = createProject("Website")!;
    const createdResponse = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "OpenAI production",
        kind: "openai",
        provider_id: "openai",
        protocol: "native",
        credential: { name: "OPENAI_KEY", value: "sk-api-secret" },
      }),
      ctx({}),
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.credential).toMatchObject({ name: "OPENAI_KEY" });
    expect(JSON.stringify(created)).not.toContain("sk-api-secret");

    const listResponse = await connectionsGET(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "GET"),
      ctx({}),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({
        id: created.id,
        project_name: "Website",
        agent_count: 0,
      }),
    ]);

    const getResponse = await connectionGET(
      userReq(`http://x/api/llm-connections/${created.id}`, "GET"),
      ctx({ id: created.id }),
    );
    expect(await getResponse.json()).toEqual(created);

    const updateResponse = await connectionPUT(
      userReq(`http://x/api/llm-connections/${created.id}`, "PUT", {
        name: "OpenAI renamed",
      }),
      ctx({ id: created.id }),
    );
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).name).toBe("OpenAI renamed");

    const rolledBack = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Duplicate credential",
        kind: "openai",
        provider_id: "openai",
        protocol: "native",
        credential: { name: "OPENAI_KEY", value: "different" },
      }),
      ctx({}),
    );
    expect(rolledBack.status).toBe(400);
    expect(listLlmConnections(project.id)).toHaveLength(1);
  });

  it("validates provider invariants, URLs, and credential input", async () => {
    const project = createProject("Website")!;

    const wrongProvider = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Wrong",
        kind: "openai",
        provider_id: "anthropic",
        protocol: "native",
        credential: { name: "KEY_A", value: "secret" },
      }),
      ctx({}),
    );
    expect(wrongProvider.status).toBe(400);

    const missingKey = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "No key",
        kind: "anthropic",
        provider_id: "anthropic",
        protocol: "native",
      }),
      ctx({}),
    );
    expect(missingKey.status).toBe(400);

    const conflictingCredential = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Two keys",
        kind: "openai",
        provider_id: "openai",
        protocol: "native",
        credential_id: "secret-id",
        credential: { name: "KEY_B", value: "secret" },
      }),
      ctx({}),
    );
    expect(conflictingCredential.status).toBe(400);

    const badUrl = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Local",
        kind: "ollama",
        provider_id: "ollama",
        base_url: "file:///tmp/model",
        protocol: "chat-completions",
      }),
      ctx({}),
    );
    expect(badUrl.status).toBe(400);

    const embeddedCredentials = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Credential leak",
        kind: "openai-compatible",
        provider_id: "proxy",
        base_url: "https://user:password@llm.example.test/v1",
        protocol: "responses",
      }),
      ctx({}),
    );
    expect(embeddedCredentials.status).toBe(400);

    const queryString = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "Query credential leak",
        kind: "openai-compatible",
        provider_id: "proxy",
        base_url: "https://llm.example.test/v1?api_key=must-not-live-in-metadata",
        protocol: "responses",
      }),
      ctx({}),
    );
    expect(queryString.status).toBe(400);
    expect(await queryString.json()).toMatchObject({
      error: expect.stringMatching(/query string/),
    });
  });

  it("returns 409 when deleting a connection bound to an agent", async () => {
    const project = createProject("Website")!;
    const secret = createEnvVar(project.id, "OPENAI_KEY", "secret")!;
    const connection = createLlmConnection(project.id, {
      name: "OpenAI",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: secret.id,
    });
    const agent = createAgent(project.id, "Builder", undefined, { cli: "opencode" });
    bindAgentToLlmConnection(agent.id, connection.id);

    expect(listLlmConnections(project.id)[0]).toMatchObject({
      id: connection.id,
      agent_count: 1,
    });

    const response = await connectionDELETE(
      userReq(`http://x/api/llm-connections/${connection.id}`, "DELETE"),
      ctx({ id: connection.id }),
    );
    expect(response.status).toBe(409);
  });

  it("returns 409 for case-insensitive connection-name collisions", async () => {
    const project = createProject("Website")!;
    const firstSecret = createEnvVar(project.id, "OPENAI_ONE", "secret")!;
    const secondSecret = createEnvVar(project.id, "OPENAI_TWO", "secret")!;
    const first = createLlmConnection(project.id, {
      name: "Production",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: firstSecret.id,
    });
    const second = createLlmConnection(project.id, {
      name: "Staging",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: secondSecret.id,
    });

    const createCollision = await connectionsPOST(
      userReq(`http://x/api/llm-connections?projectId=${project.id}`, "POST", {
        name: "production",
        kind: "ollama",
        provider_id: "ollama",
        protocol: "chat-completions",
      }),
      ctx({}),
    );
    expect(createCollision.status).toBe(409);

    const updateCollision = await connectionPUT(
      userReq(`http://x/api/llm-connections/${second.id}`, "PUT", { name: "PRODUCTION" }),
      ctx({ id: second.id }),
    );
    expect(updateCollision.status).toBe(409);

    const selfRename = await connectionPUT(
      userReq(`http://x/api/llm-connections/${first.id}`, "PUT", { name: "production" }),
      ctx({ id: first.id }),
    );
    expect(selfRename.status).toBe(200);
  });

  it("clears an optional credential explicitly without deleting its Secret", async () => {
    const project = createProject("Lab")!;
    const secret = createEnvVar(project.id, "LAB_KEY", "secret")!;
    const connection = createLlmConnection(project.id, {
      name: "Lab proxy",
      kind: "openai-compatible",
      providerId: "lab",
      baseUrl: "https://llm.example.test/v1",
      protocol: "responses",
      credentialId: secret.id,
    });

    const response = await connectionPUT(
      userReq(`http://x/api/llm-connections/${connection.id}`, "PUT", {
        credential_id: null,
      }),
      ctx({ id: connection.id }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).credential).toBeNull();
    expect(getEnvVarById(secret.id)).not.toBeNull();
  });
});

describe("OpenCode connection binding validation", () => {
  function connectionFixture() {
    const project = createProject("Website")!;
    const secret = createEnvVar(project.id, "OPENAI_KEY", "secret")!;
    const connection = createLlmConnection(project.id, {
      name: "OpenAI",
      kind: "openai",
      providerId: "openai",
      protocol: "native",
      credentialId: secret.id,
    });
    return { project, connection };
  }

  it("requires a connection and canonical provider/model when creating an OpenCode agent", async () => {
    const { project, connection } = connectionFixture();

    const missing = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Missing",
        cli: "opencode",
        model: "openai/gpt-5",
      }),
      ctx({}),
    );
    expect(missing.status).toBe(400);

    const mismatched = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Mismatch",
        cli: "opencode",
        model: "anthropic/claude-sonnet-4",
        llm_connection_id: connection.id,
      }),
      ctx({}),
    );
    expect(mismatched.status).toBe(400);

    const malformed = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Malformed",
        cli: "opencode",
        model: "openai/gpt 5",
        llm_connection_id: connection.id,
      }),
      ctx({}),
    );
    expect(malformed.status).toBe(400);

    const valid = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Builder",
        cli: "opencode",
        model: "openai/gpt-5",
        llm_connection_id: connection.id,
      }),
      ctx({}),
    );
    expect(valid.status).toBe(201);
    const body = await valid.json();
    expect(body.llm_connection).toMatchObject({ id: connection.id, provider_id: "openai" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("rejects bindings on other CLIs and connections from another project", async () => {
    const { project, connection } = connectionFixture();
    const otherProject = createProject("Other")!;

    const otherCli = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Claude",
        cli: "claude",
        llm_connection_id: connection.id,
      }),
      ctx({}),
    );
    expect(otherCli.status).toBe(400);

    const crossProject = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${otherProject.id}`, "POST", {
        name: "Foreign",
        cli: "opencode",
        model: "openai/gpt-5",
        llm_connection_id: connection.id,
      }),
      ctx({}),
    );
    expect(crossProject.status).toBe(400);
  });

  it("validates agent edits and removes the binding when switching away from OpenCode", async () => {
    const { project, connection } = connectionFixture();
    const agent = createAgent(project.id, "Builder", undefined, {
      cli: "opencode",
      model: "openai/gpt-5",
      llmConnectionId: connection.id,
    });

    const mismatch = await agentPUT(
      userReq(`http://x/api/agents/${agent.id}`, "PUT", {
        model: "anthropic/claude-sonnet-4",
      }),
      ctx({ id: agent.id }),
    );
    expect(mismatch.status).toBe(400);

    const switched = await agentPUT(
      userReq(`http://x/api/agents/${agent.id}`, "PUT", {
        cli: "claude",
        model: "sonnet",
        thinking: "",
      }),
      ctx({ id: agent.id }),
    );
    expect(switched.status).toBe(200);
    expect((await switched.json()).llm_connection).toBeNull();
  });

  it("rejects a provider switch that would strand an existing job model override", async () => {
    const { project, connection } = connectionFixture();
    const anthropicSecret = createEnvVar(project.id, "ANTHROPIC_KEY", "secret")!;
    const anthropic = createLlmConnection(project.id, {
      name: "Anthropic",
      kind: "anthropic",
      providerId: "anthropic",
      protocol: "native",
      credentialId: anthropicSecret.id,
    });
    const agent = createAgent(project.id, "Builder", undefined, {
      cli: "opencode",
      model: "openai/gpt-5",
      llmConnectionId: connection.id,
    });
    createJob(project.id, agent.id, {
      name: "Pinned model",
      schedule: '{"every":60}',
      model: "openai/gpt-5-mini",
    });

    const response = await agentPUT(
      userReq(`http://x/api/agents/${agent.id}`, "PUT", {
        llm_connection_id: anthropic.id,
        model: "anthropic/claude-sonnet-4",
      }),
      ctx({ id: agent.id }),
    );
    expect(response.status).toBe(400);

    expect(getAgentById(agent.id)?.llm_connection_id).toBe(connection.id);
    expect(getAgentById(agent.id)?.model).toBe("openai/gpt-5");
  });

  it("keeps job model overrides on the bound provider", async () => {
    const { project, connection } = connectionFixture();
    const agent = createAgent(project.id, "Builder", undefined, {
      cli: "opencode",
      model: "openai/gpt-5",
      llmConnectionId: connection.id,
    });

    const rejectedCreate = await agentJobsPOST(
      userReq(`http://x/api/agents/${agent.id}/jobs`, "POST", {
        name: "Bad model",
        schedule: '{"every":60}',
        model: "anthropic/claude-sonnet-4",
      }),
      ctx({ id: agent.id }),
    );
    expect(rejectedCreate.status).toBe(400);

    const acceptedCreate = await agentJobsPOST(
      userReq(`http://x/api/agents/${agent.id}/jobs`, "POST", {
        name: "Good model",
        schedule: '{"every":60}',
        model: "openai/gpt-5-mini",
      }),
      ctx({ id: agent.id }),
    );
    expect(acceptedCreate.status).toBe(201);
    const job = await acceptedCreate.json();

    const rejectedUpdate = await jobPUT(
      userReq(`http://x/api/jobs/${job.id}`, "PUT", {
        model: "openrouter/openai/gpt-5",
      }),
      ctx({ id: job.id }),
    );
    expect(rejectedUpdate.status).toBe(400);

    const acceptedUpdate = await jobPUT(
      userReq(`http://x/api/jobs/${job.id}`, "PUT", { model: "openai/gpt-5-nano" }),
      ctx({ id: job.id }),
    );
    expect(acceptedUpdate.status).toBe(200);
  });
});
