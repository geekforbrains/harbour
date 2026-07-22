import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { PUT as jobPUT } from "@/app/api/jobs/[id]/route";
import { POST as jobsPOST } from "@/app/api/jobs/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/settings/route";
import { POST as tablesPOST } from "@/app/api/tables/route";
import {
  createAgent,
  createProject,
  createSession,
  createUser,
  createWorkflow,
  getJobById,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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
  const project = createProject("Site")!;
  const user = createUser("u@x.com", "pw", "User")!;
  const agent = createAgent(project.id, "Dev");
  return { project, user, agent };
}

describe("POST /api/agents/:id/jobs validation", () => {
  it("returns 400 (not 500) on a malformed JSON body", async () => {
    const { user, agent } = fixture();
    const req = userReq(user.id, "http://localhost/api/agents/x/jobs", "{not valid json");
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) when docIds is a string instead of an array", async () => {
    const { user, agent } = fixture();
    const req = userReq(
      user.id,
      "http://localhost/api/agents/x/jobs",
      JSON.stringify({ name: "J", schedule: '{"every":60}', docIds: "doc-1" }),
    );
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
  });

  it("accepts a valid agent job", async () => {
    const { user, agent } = fixture();
    const req = userReq(
      user.id,
      "http://localhost/api/agents/x/jobs",
      JSON.stringify({ name: "J", schedule: '{"every":60}', docIds: [] }),
    );
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBeLessThan(300);
  });
});

describe("POST /api/jobs (workflow) validation", () => {
  it("returns 400 when command is missing", async () => {
    const { project, user } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/jobs?projectId=${project.id}`,
      JSON.stringify({ name: "W", schedule: '{"every":60}' }),
    );
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when command is a non-string", async () => {
    const { project, user } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/jobs?projectId=${project.id}`,
      JSON.stringify({ name: "W", schedule: '{"every":60}', command: 123 }),
    );
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("accepts a valid workflow", async () => {
    const { project, user } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/jobs?projectId=${project.id}`,
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
    const { project, user } = fixture();
    const wf = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "node", content: "console.log(1)" },
    })!;
    // Sanity: the gate is stored.
    expect(getJobById(wf.id).workflow_script).toBe("console.log(1)");

    // command:null must clear it — the bug was `command ?? workflow` collapsing
    // null to undefined and leaving the gate unchanged.
    const res = await jobPUT(putReq(user.id, wf.id, { command: null }), ctx({ id: wf.id }));
    expect(res.status).toBeLessThan(300);
    const after = getJobById(wf.id);
    expect(after.workflow_script).toBeNull();
    expect(after.workflow_runtime).toBeNull();
  });

  it("rejects a malformed gate with 400", async () => {
    const { project, user } = fixture();
    const wf = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const res = await jobPUT(
      putReq(user.id, wf.id, { command: { runtime: "ruby", content: "x" } }),
      ctx({ id: wf.id }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when tableIds is not an array (parity with docIds/envVarIds)", async () => {
    const { project, user } = fixture();
    const wf = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const res = await jobPUT(
      putReq(user.id, wf.id, { tableIds: "not-an-array" }),
      ctx({ id: wf.id }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tables validation", () => {
  it("returns 400 on an unsupported column type", async () => {
    const { project, user } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/tables?projectId=${project.id}`,
      JSON.stringify({ name: "mydb", columns: [{ name: "col", type: "VARCHAR" }] }),
    );
    const res = await tablesPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("accepts supported column types", async () => {
    const { project, user } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/tables?projectId=${project.id}`,
      JSON.stringify({ name: "mydb", columns: [{ name: "col", type: "TEXT" }] }),
    );
    const res = await tablesPOST(req, ctx({}));
    expect(res.status).toBeLessThan(300);
  });
});

describe("/api/settings validation", () => {
  function settingsPutReq(userId: string, body: unknown): NextRequest {
    const sessionId = createSession(userId);
    const headers = new Headers();
    headers.set("cookie", `harbour_session=${sessionId}`);
    return new NextRequest("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
      headers,
    });
  }

  it("rejects unknown setting keys", async () => {
    const { user } = fixture();
    const res = await settingsPUT(settingsPutReq(user.id, { unknown_setting: "value" }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("rejects non-string setting values", async () => {
    const { user } = fixture();
    const res = await settingsPUT(settingsPutReq(user.id, { recent_runs_limit: 20 }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("does not return unsupported rows left in the settings table", async () => {
    const { user } = fixture();
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('legacy_setting', 'secret')`).run();
    const sessionId = createSession(user.id);
    const req = new NextRequest("http://localhost/api/settings", {
      headers: { cookie: `harbour_session=${sessionId}` },
    });
    const res = await settingsGET(req, ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("legacy_setting");
  });
});
