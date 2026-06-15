import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { POST as databasesPOST } from "@/app/api/databases/route";
import { PUT as jobPUT } from "@/app/api/jobs/[id]/route";
import { POST as jobsPOST } from "@/app/api/jobs/route";
import {
  addMembership,
  createAgent,
  createOrg,
  createProject,
  createSession,
  createUser,
  createWorkflow,
  getJobById,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// Integration coverage for the input-validation convention: every mutation
// endpoint either accepts valid input or rejects bad input with a clean 4xx —
// never a 500 on a malformed body and never a silently-stored wrong-typed value.

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

afterEach(() => {
  resetDb();
});

function userReq(userId: string, url: string, body?: string): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers();
  headers.set("cookie", `harbour_session=${sessionId}`);
  return new NextRequest(url, { method: "POST", body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  addMembership(editor.id, org.id, "editor");
  const agent = createAgent(project.id, "Dev");
  return { org, project, editor, agent };
}

describe("POST /api/agents/:id/jobs validation", () => {
  it("returns 400 (not 500) on a malformed JSON body", async () => {
    const { editor, agent } = fixture();
    const req = userReq(editor.id, "http://localhost/api/agents/x/jobs", "{not valid json");
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) when docIds is a string instead of an array", async () => {
    const { editor, agent } = fixture();
    const req = userReq(
      editor.id,
      "http://localhost/api/agents/x/jobs",
      JSON.stringify({ name: "J", schedule: '{"every":60}', docIds: "doc-1" }),
    );
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
  });

  it("accepts a valid agent job", async () => {
    const { editor, agent } = fixture();
    const req = userReq(
      editor.id,
      "http://localhost/api/agents/x/jobs",
      JSON.stringify({ name: "J", schedule: '{"every":60}', docIds: [] }),
    );
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBeLessThan(300);
  });
});

describe("POST /api/jobs (workflow) validation", () => {
  it("returns 400 when command is missing", async () => {
    const { org, editor } = fixture();
    const req = userReq(
      editor.id,
      `http://localhost/api/jobs?orgId=${org.id}`,
      JSON.stringify({ name: "W", schedule: '{"every":60}' }),
    );
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when command is a non-string", async () => {
    const { org, editor } = fixture();
    const req = userReq(
      editor.id,
      `http://localhost/api/jobs?orgId=${org.id}`,
      JSON.stringify({ name: "W", schedule: '{"every":60}', command: 123 }),
    );
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("accepts a valid workflow", async () => {
    const { org, editor } = fixture();
    const req = userReq(
      editor.id,
      `http://localhost/api/jobs?orgId=${org.id}`,
      JSON.stringify({
        name: "W",
        schedule: '{"every":60}',
        command: { runtime: "bash", content: "echo hi" },
      }),
    );
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBeLessThan(300);
  });
});

describe("PUT /api/jobs/:id gate clearing", () => {
  function putReq(userId: string, id: string, body: unknown): NextRequest {
    const sessionId = createSession(userId);
    const headers = new Headers();
    headers.set("cookie", `harbour_session=${sessionId}`);
    return new NextRequest(`http://localhost/api/jobs/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers,
    });
  }

  it("clears a gate when the alias key is sent as null (not a silent no-op)", async () => {
    const { org, project, editor } = fixture();
    const wf = createWorkflow(org.id, project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "node", content: "console.log(1)" },
    })!;
    // Sanity: the gate is stored.
    expect(getJobById(wf.id).workflow_script).toBe("console.log(1)");

    // command:null must clear it — the bug was `command ?? workflow` collapsing
    // null to undefined and leaving the gate unchanged.
    const res = await jobPUT(putReq(editor.id, wf.id, { command: null }), ctx({ id: wf.id }));
    expect(res.status).toBeLessThan(300);
    const after = getJobById(wf.id);
    expect(after.workflow_script).toBeNull();
    expect(after.workflow_runtime).toBeNull();
  });

  it("rejects a malformed gate with 400", async () => {
    const { org, project, editor } = fixture();
    const wf = createWorkflow(org.id, project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const res = await jobPUT(
      putReq(editor.id, wf.id, { command: { runtime: "ruby", content: "x" } }),
      ctx({ id: wf.id }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/databases validation", () => {
  it("returns 400 on an unsupported column type", async () => {
    const { org, editor } = fixture();
    const req = userReq(
      editor.id,
      `http://localhost/api/databases?orgId=${org.id}`,
      JSON.stringify({ name: "mydb", columns: [{ name: "col", type: "VARCHAR" }] }),
    );
    const res = await databasesPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("accepts supported column types", async () => {
    const { org, editor } = fixture();
    const req = userReq(
      editor.id,
      `http://localhost/api/databases?orgId=${org.id}`,
      JSON.stringify({ name: "mydb", columns: [{ name: "col", type: "TEXT" }] }),
    );
    const res = await databasesPOST(req, ctx({}));
    expect(res.status).toBeLessThan(300);
  });
});
