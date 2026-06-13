import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELETE as scriptDELETE,
  PUT as scriptPUT,
} from "@/app/api/jobs/[id]/scripts/[scriptId]/route";
import { GET as scriptsGET, POST as scriptsPOST } from "@/app/api/jobs/[id]/scripts/route";
import {
  addMembership,
  createAgent,
  createJob,
  createJobScript,
  createOrg,
  createProject,
  createSession,
  createUser,
  getJobScriptById,
  listJobScripts,
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

afterEach(() => {
  resetDb();
});

type ReqInit = { method?: string; body?: string; headers?: HeadersInit };

function userReq(userId: string, url: string, init: ReqInit = {}): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers(init.headers);
  headers.set("cookie", `harbour_session=${sessionId}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  const viewer = createUser("v@x.com", "pw", "Viewer")!;
  const outsider = createUser("o@x.com", "pw", "Outsider")!;
  addMembership(editor.id, org.id, "editor");
  addMembership(viewer.id, org.id, "viewer");
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
  return { org, project, editor, viewer, outsider, agent, job };
}

// A second, fully independent org used to assert cross-tenant isolation.
function otherOrgFixture() {
  const org = createOrg("Globex")!;
  const project = createProject(org.id, "OtherSite")!;
  const agent = createAgent(project.id, "OtherDev");
  const job = createJob(project.id, agent.id, { name: "OtherJob", schedule: '{"every":60}' })!;
  const script = createJobScript({ jobId: job.id, filename: "other.sh", content: "echo hi" });
  return { org, project, agent, job, script };
}

const jsonInit = (method: string, body: unknown): ReqInit => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("GET /api/jobs/[id]/scripts", () => {
  it("viewer lists the job's scripts", async () => {
    const { job, viewer } = fixture();
    createJobScript({ jobId: job.id, filename: "prerun.sh", content: "echo go" });
    const res = await scriptsGET(userReq(viewer.id, "http://x/"), ctx({ id: job.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].filename).toBe("prerun.sh");
  });

  it("outsider is forbidden (cross-org returns 403)", async () => {
    const { job, outsider } = fixture();
    const res = await scriptsGET(userReq(outsider.id, "http://x/"), ctx({ id: job.id }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/jobs/[id]/scripts", () => {
  it("editor creates a script (executable defaults on)", async () => {
    const { job, editor } = fixture();
    const res = await scriptsPOST(
      userReq(editor.id, "http://x/", jsonInit("POST", { filename: "check.py", content: "x=1" })),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filename).toBe("check.py");
    expect(body.content).toBe("x=1");
    expect(body.executable).toBe(1);
    expect(listJobScripts(job.id).length).toBe(1);
  });

  it("viewer cannot create a script (editor role enforced)", async () => {
    const { job, viewer } = fixture();
    const res = await scriptsPOST(
      userReq(viewer.id, "http://x/", jsonInit("POST", { filename: "check.py" })),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a missing filename with 400", async () => {
    const { job, editor } = fixture();
    const res = await scriptsPOST(
      userReq(editor.id, "http://x/", jsonInit("POST", { content: "x=1" })),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a filename with a path separator (400)", async () => {
    const { job, editor } = fixture();
    const res = await scriptsPOST(
      userReq(editor.id, "http://x/", jsonInit("POST", { filename: "../etc/passwd" })),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(400);
    expect(listJobScripts(job.id).length).toBe(0);
  });
});

describe("PUT /api/jobs/[id]/scripts/[scriptId]", () => {
  it("editor updates a script's content", async () => {
    const { job, editor } = fixture();
    const script = createJobScript({ jobId: job.id, filename: "prerun.sh", content: "old" });
    const res = await scriptPUT(
      userReq(editor.id, "http://x/", jsonInit("PUT", { content: "new" })),
      ctx({ id: job.id, scriptId: script.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe("new");
  });

  it("viewer cannot update a script (editor role enforced)", async () => {
    const { job, viewer } = fixture();
    const script = createJobScript({ jobId: job.id, filename: "prerun.sh" });
    const res = await scriptPUT(
      userReq(viewer.id, "http://x/", jsonInit("PUT", { content: "new" })),
      ctx({ id: job.id, scriptId: script.id }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects an invalid filename with 400", async () => {
    const { job, editor } = fixture();
    const script = createJobScript({ jobId: job.id, filename: "prerun.sh" });
    const res = await scriptPUT(
      userReq(editor.id, "http://x/", jsonInit("PUT", { filename: "a/b" })),
      ctx({ id: job.id, scriptId: script.id }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when the script belongs to a different job (no cross-job mutation)", async () => {
    const { job, editor } = fixture();
    const other = otherOrgFixture();
    const res = await scriptPUT(
      userReq(editor.id, "http://x/", jsonInit("PUT", { content: "leak" })),
      ctx({ id: job.id, scriptId: other.script.id }),
    );
    expect(res.status).toBe(404);
    expect(getJobScriptById(other.script.id)!.content).toBe("echo hi");
  });
});

describe("DELETE /api/jobs/[id]/scripts/[scriptId]", () => {
  it("editor deletes a script", async () => {
    const { job, editor } = fixture();
    const script = createJobScript({ jobId: job.id, filename: "prerun.sh" });
    const res = await scriptDELETE(
      userReq(editor.id, "http://x/"),
      ctx({ id: job.id, scriptId: script.id }),
    );
    expect(res.status).toBe(200);
    expect(getJobScriptById(script.id)).toBeNull();
  });

  it("viewer cannot delete a script (editor role enforced)", async () => {
    const { job, viewer } = fixture();
    const script = createJobScript({ jobId: job.id, filename: "prerun.sh" });
    const res = await scriptDELETE(
      userReq(viewer.id, "http://x/"),
      ctx({ id: job.id, scriptId: script.id }),
    );
    expect(res.status).toBe(403);
  });

  it("404 when the script belongs to a different job (no cross-job delete)", async () => {
    const { job, editor } = fixture();
    const other = otherOrgFixture();
    const res = await scriptDELETE(
      userReq(editor.id, "http://x/"),
      ctx({ id: job.id, scriptId: other.script.id }),
    );
    expect(res.status).toBe(404);
    expect(getJobScriptById(other.script.id)).not.toBeNull();
  });
});
