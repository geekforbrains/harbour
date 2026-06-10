import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requireAgentProject,
  requireAgentSelf,
  withAgentAuth,
  withAgentOrUser,
  withAuthenticatedUser,
  withInstanceAdmin,
  withOrgAuth,
  withProjectAuth,
  withResourceAuth,
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

/** Build a request authenticated as an agent via its API key. */
function agentReq(apiKey: string, url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
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

  it("403 for an agent (org auth is user-only)", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev");
    const read = withOrgAuth(ok, { role: "viewer" });
    expect((await read(agentReq(agent.apiKey, `http://x/?orgId=${org.id}`), ctx({}))).status).toBe(
      403,
    );
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
  it("allows any signed-in user, rejects agents + anon", async () => {
    const { project, viewer } = fixture();
    const agent = createAgent(project.id, "Dev");
    const handler = withAuthenticatedUser(ok);
    expect((await handler(userReq(viewer.id, "http://x/"), ctx({}))).status).toBe(200);
    expect((await handler(agentReq(agent.apiKey, "http://x/"), ctx({}))).status).toBe(403);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
  });
});

// ===========================================================================
// withAgentAuth — scoped to the agent's project
// ===========================================================================

describe("withAgentAuth", () => {
  it("passes a valid agent key and exposes its org/project", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev");
    let captured: { orgId: string; projectId: string } | null = null;
    const handler = withAgentAuth(async (_req, auth) => {
      captured = { orgId: auth.orgId, projectId: auth.projectId };
      return ok();
    });
    const res = await handler(agentReq(agent.apiKey, "http://x/"), ctx({}));
    expect(res.status).toBe(200);
    expect(captured!).toEqual({ orgId: org.id, projectId: project.id });
  });

  it("403 for a user (agent-only)", async () => {
    const { viewer } = fixture();
    const handler = withAgentAuth(ok);
    expect((await handler(userReq(viewer.id, "http://x/"), ctx({}))).status).toBe(403);
  });

  it("401 for a bad key", async () => {
    fixture();
    const handler = withAgentAuth(ok);
    expect((await handler(agentReq("hbr_bogus", "http://x/"), ctx({}))).status).toBe(401);
  });

  it("requireAgentSelf rejects a different agent id", async () => {
    const { project } = fixture();
    const agent = createAgent(project.id, "Dev");
    const handler = withAgentAuth(async (_req, auth, { params }) => {
      const { id } = await params;
      const err = requireAgentSelf(auth, id);
      return err ?? ok();
    });
    expect((await handler(agentReq(agent.apiKey, "http://x/"), ctx({ id: agent.id }))).status).toBe(
      200,
    );
    expect((await handler(agentReq(agent.apiKey, "http://x/"), ctx({ id: "other" }))).status).toBe(
      403,
    );
  });

  it("requireAgentProject rejects a resource in another project's org", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev");

    // A run in the same org/project — allowed.
    const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    // A run in a different org — denied.
    const otherOrg = createOrg("Other")!;
    const otherProject = createProject(otherOrg.id, "P2")!;
    const otherAgent = createAgent(otherProject.id, "Dev2");
    const otherJob = createJob(otherProject.id, otherAgent.id, {
      name: "J2",
      schedule: '{"every":60}',
    })!;
    const otherRun = createRun(otherJob.id, otherAgent.id)!;

    const handler = withAgentAuth(async (_req, auth, { params }) => {
      const { id } = await params;
      const err = requireAgentProject(auth, "run", id);
      return err ?? ok();
    });
    expect((await handler(agentReq(agent.apiKey, "http://x/"), ctx({ id: run.id }))).status).toBe(
      200,
    );
    expect(
      (await handler(agentReq(agent.apiKey, "http://x/"), ctx({ id: otherRun.id }))).status,
    ).toBe(403);
    expect(org.id).toBeTruthy();
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

  it("an agent passes when the resource is in its org, denied otherwise", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev");
    const sameDoc = createDoc(org.id, project.id, "Spec")!;

    const otherOrg = createOrg("Other")!;
    const otherDoc = createDoc(otherOrg.id, null, "Foreign")!;

    const handler = (docOrg: string) =>
      withAgentOrUser(ok, { role: "editor", orgFromParams: () => docOrg });

    expect(
      (await handler(sameDoc.org_id)(agentReq(agent.apiKey, "http://x/"), ctx({ id: sameDoc.id })))
        .status,
    ).toBe(200);
    expect(
      (
        await handler(otherDoc.org_id)(
          agentReq(agent.apiKey, "http://x/"),
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
});
