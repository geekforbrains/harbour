import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  withAgentOrUser,
  withAuthenticatedUser,
  withInstanceAdmin,
  withOrgAuth,
  withProjectAuth,
  withResourceAuth,
  withRunExecutorOrUser,
} from "@/lib/auth";
import {
  addMembership,
  createAgent,
  createDoc,
  createJob,
  createOrg,
  createProject,
  createRun,
  createSession,
  createUser,
  mintExecToken,
  updateRunStatus,
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

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a request authenticated as a user via a session cookie. */
function userReq(userId: string, url: string): NextRequest {
  const sessionId = createSession(userId);
  return new NextRequest(url, {
    headers: { cookie: `harbour_session=${sessionId}` },
  });
}

/** Build a request carrying a bearer token (a run's exec token or a runner token). */
function bearerReq(token: string, url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Create an agent + job + run in a project. Agents have no standalone credential,
 * so tests act "as an agent" through its run's exec token — this returns both the
 * agent (to assert on) and the run id (to mint the token from).
 */
function agentRun(projectId: string, name = "Dev") {
  const agent = createAgent(projectId, name, undefined, { cli: "claude" });
  const job = createJob(projectId, agent.id, { name: "J", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  return { agent, runId: run.id };
}

/** Build an unauthenticated request. */
function anonReq(url: string): NextRequest {
  return new NextRequest(url);
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

const ok = () => new Response("ok", { status: 200 });

// Common fixture: org with project, an editor, a viewer, a non-member, an admin.
function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  const viewer = createUser("v@x.com", "pw", "Viewer")!;
  const outsider = createUser("o@x.com", "pw", "Outsider")!;
  const admin = createUser("a@x.com", "pw", "Admin", { isInstanceAdmin: true })!;
  addMembership(editor.id, org.id, "editor");
  addMembership(viewer.id, org.id, "viewer");
  return { org, project, editor, viewer, outsider, admin };
}

// ===========================================================================
// withOrgAuth
// ===========================================================================

describe("withOrgAuth", () => {
  it("401 for an unauthenticated request", async () => {
    const { org } = fixture();
    const handler = withOrgAuth(ok, { role: "viewer" });
    const res = await handler(anonReq(`http://x/api/x?orgId=${org.id}`), ctx({}));
    expect(res.status).toBe(401);
  });

  it("viewer can read but not write", async () => {
    const { org, viewer } = fixture();
    const read = withOrgAuth(ok, { role: "viewer" });
    const write = withOrgAuth(ok, { role: "editor" });
    expect((await read(userReq(viewer.id, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(200);
    expect((await write(userReq(viewer.id, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(
      403,
    );
  });

  it("editor can write", async () => {
    const { org, editor } = fixture();
    const write = withOrgAuth(ok, { role: "editor" });
    expect((await write(userReq(editor.id, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(
      200,
    );
  });

  it("instance_admin satisfies any role", async () => {
    const { org, admin } = fixture();
    const write = withOrgAuth(ok, { role: "editor" });
    expect((await write(userReq(admin.id, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(200);
  });

  it("403 for a non-member of the org", async () => {
    const { org, outsider } = fixture();
    const read = withOrgAuth(ok, { role: "viewer" });
    expect((await read(userReq(outsider.id, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(
      403,
    );
  });

  it("403 when no org can be determined", async () => {
    const { viewer } = fixture();
    const read = withOrgAuth(ok, { role: "viewer" });
    expect((await read(userReq(viewer.id, `http://x/`), ctx({}))).status).toBe(403);
  });

  it("reads org from the harbour_org cookie when no query param", async () => {
    const { org, viewer } = fixture();
    const sessionId = createSession(viewer.id);
    const req = new NextRequest("http://x/", {
      headers: { cookie: `harbour_session=${sessionId}; harbour_org=${org.id}` },
    });
    const read = withOrgAuth(ok, { role: "viewer" });
    expect((await read(req, ctx({}))).status).toBe(200);
  });

  it("403 for a run executor (org auth is user-only)", async () => {
    const { org, project } = fixture();
    const { runId } = agentRun(project.id);
    const read = withOrgAuth(ok, { role: "viewer" });
    expect(
      (await read(bearerReq(mintExecToken(runId), `http://x/?orgId=${org.id}`), ctx({}))).status,
    ).toBe(403);
  });
});

// ===========================================================================
// withProjectAuth
// ===========================================================================

describe("withProjectAuth", () => {
  it("resolves the org from the project and checks role", async () => {
    const { project, viewer, editor, outsider } = fixture();
    const read = withProjectAuth(ok, { role: "viewer" });
    const write = withProjectAuth(ok, { role: "editor" });
    expect(
      (await read(userReq(viewer.id, `http://x/?projectId=${project.id}`), ctx({}))).status,
    ).toBe(200);
    expect(
      (await write(userReq(viewer.id, `http://x/?projectId=${project.id}`), ctx({}))).status,
    ).toBe(403);
    expect(
      (await write(userReq(editor.id, `http://x/?projectId=${project.id}`), ctx({}))).status,
    ).toBe(200);
    expect(
      (await read(userReq(outsider.id, `http://x/?projectId=${project.id}`), ctx({}))).status,
    ).toBe(403);
  });

  it("403 when the project is missing or unknown", async () => {
    const { viewer } = fixture();
    const read = withProjectAuth(ok, { role: "viewer" });
    expect((await read(userReq(viewer.id, `http://x/`), ctx({}))).status).toBe(403);
    expect((await read(userReq(viewer.id, `http://x/?projectId=nope`), ctx({}))).status).toBe(403);
  });
});

// ===========================================================================
// withResourceAuth
// ===========================================================================

describe("withResourceAuth", () => {
  it("resolves a run's org and enforces the role", async () => {
    const { org, project, viewer, editor, outsider } = fixture();
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    const read = withResourceAuth("run", "id", { role: "viewer" })(ok);
    const write = withResourceAuth("run", "id", { role: "editor" })(ok);

    expect((await read(userReq(viewer.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await write(userReq(viewer.id, "http://x/"), ctx({ id: run.id }))).status).toBe(403);
    expect((await write(userReq(editor.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await read(userReq(outsider.id, "http://x/"), ctx({ id: run.id }))).status).toBe(403);
    expect(org.id).toBeTruthy();
  });

  it("403 for a non-existent resource (don't leak existence)", async () => {
    const { editor } = fixture();
    const read = withResourceAuth("doc", "id", { role: "viewer" })(ok);
    expect((await read(userReq(editor.id, "http://x/"), ctx({ id: "ghost" }))).status).toBe(403);
  });
});

// ===========================================================================
// withInstanceAdmin
// ===========================================================================

describe("withInstanceAdmin", () => {
  it("only an instance admin passes", async () => {
    const { admin, editor } = fixture();
    const handler = withInstanceAdmin(ok);
    expect((await handler(userReq(admin.id, "http://x/"), ctx({}))).status).toBe(200);
    expect((await handler(userReq(editor.id, "http://x/"), ctx({}))).status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    fixture();
    const handler = withInstanceAdmin(ok);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
  });
});

// ===========================================================================
// withAuthenticatedUser
// ===========================================================================

describe("withAuthenticatedUser", () => {
  it("allows any signed-in user, rejects run executors + anon", async () => {
    const { project, viewer } = fixture();
    const { runId } = agentRun(project.id);
    const handler = withAuthenticatedUser(ok);
    expect((await handler(userReq(viewer.id, "http://x/"), ctx({}))).status).toBe(200);
    expect((await handler(bearerReq(mintExecToken(runId), "http://x/"), ctx({}))).status).toBe(403);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
  });
});

// ===========================================================================
// withAgentOrUser — dual-identity resource routes
// ===========================================================================

describe("withAgentOrUser", () => {
  it("an editor user passes; a viewer is denied for editor routes", async () => {
    const { org, viewer, editor } = fixture();
    const doc = createDoc(org.id, null, "Brand")!;
    const handler = withAgentOrUser(ok, {
      role: "editor",
      orgFromParams: () => doc.org_id,
    });
    expect((await handler(userReq(editor.id, "http://x/"), ctx({ id: doc.id }))).status).toBe(200);
    expect((await handler(userReq(viewer.id, "http://x/"), ctx({ id: doc.id }))).status).toBe(403);
  });

  it("a run executor passes when the resource is in its agent's org, denied otherwise", async () => {
    const { org, project } = fixture();
    const { runId } = agentRun(project.id);
    const sameDoc = createDoc(org.id, project.id, "Spec")!;

    const otherOrg = createOrg("Other")!;
    const otherDoc = createDoc(otherOrg.id, null, "Foreign")!;

    const handler = (docOrg: string) =>
      withAgentOrUser(ok, { role: "editor", orgFromParams: () => docOrg });

    expect(
      (
        await handler(sameDoc.org_id)(
          bearerReq(mintExecToken(runId), "http://x/"),
          ctx({ id: sameDoc.id }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handler(otherDoc.org_id)(
          bearerReq(mintExecToken(runId), "http://x/"),
          ctx({ id: otherDoc.id }),
        )
      ).status,
    ).toBe(403);
  });

  it("401 unauthenticated", async () => {
    fixture();
    const handler = withAgentOrUser(ok, { role: "viewer" });
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
  });

  it("an agent-run executor acts as its agent while running, but is denied once terminal", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!; // born 'running'
    const doc = createDoc(org.id, project.id, "Spec")!;
    const handler = withAgentOrUser(ok, { role: "editor", orgFromParams: () => doc.org_id });

    // While the run executes, its exec token can write the agent's resources.
    const token = mintExecToken(run.id);
    expect((await handler(bearerReq(token, "http://x/"), ctx({ id: doc.id }))).status).toBe(200);

    // Once the run is terminal, a lingering/leaked token can no longer write
    // org data (the executor goes inert for resource routes).
    updateRunStatus(run.id, "done");
    expect((await handler(bearerReq(token, "http://x/"), ctx({ id: doc.id }))).status).toBe(403);
  });
});

// ===========================================================================
// withRunExecutorOrUser — run-lifecycle routes (exec token bound to one run, or user)
// ===========================================================================

describe("withRunExecutorOrUser", () => {
  function runFixture() {
    const base = fixture();
    const agent = createAgent(base.project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(base.project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;
    return { ...base, agent, job, run };
  }

  it("a run's exec token, bound to that run id, passes", async () => {
    const { run } = runFixture();
    const handler = withRunExecutorOrUser(ok, { role: "editor" });
    const res = await handler(bearerReq(mintExecToken(run.id), "http://x/"), ctx({ id: run.id }));
    expect(res.status).toBe(200);
  });

  it("an exec token presented for a DIFFERENT run id is forbidden", async () => {
    const { project, run } = runFixture();
    const otherRun = createRun(
      createJob(project.id, createAgent(project.id, "DevB", undefined, { cli: "claude" }).id, {
        name: "K",
        schedule: '{"every":60}',
      })!.id,
      null,
    )!;
    const handler = withRunExecutorOrUser(ok, { role: "viewer" });
    const res = await handler(
      bearerReq(mintExecToken(otherRun.id), "http://x/"),
      ctx({ id: run.id }),
    );
    expect(res.status).toBe(403);
  });

  it("a terminal run's exec token still reaches lifecycle routes (trailing postrun)", async () => {
    const { run } = runFixture();
    const token = mintExecToken(run.id);
    updateRunStatus(run.id, "done");
    // The token stays valid for the run's own lifecycle routes — the runner's
    // postrun gate posts activity / may override done->failed after the run
    // reports terminal. (The org-data gate lives on withAgentOrUser, below.)
    const handler = withRunExecutorOrUser(ok, { role: "viewer" });
    const res = await handler(bearerReq(token, "http://x/"), ctx({ id: run.id }));
    expect(res.status).toBe(200);
  });

  it("a user meeting the role in the run's org passes; a viewer is denied editor", async () => {
    const { run, editor, viewer } = runFixture();
    const editorH = withRunExecutorOrUser(ok, { role: "editor" });
    expect((await editorH(userReq(editor.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await editorH(userReq(viewer.id, "http://x/"), ctx({ id: run.id }))).status).toBe(403);
  });

  it("an outsider is forbidden", async () => {
    const { run, outsider } = runFixture();
    const handler = withRunExecutorOrUser(ok, { role: "viewer" });
    expect((await handler(userReq(outsider.id, "http://x/"), ctx({ id: run.id }))).status).toBe(
      403,
    );
    // (A foreign run's exec token is covered above; an agent has no other key.)
  });
});
