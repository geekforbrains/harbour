import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuthContext,
  withAgentOrUser,
  withAuthenticatedUser,
  withRunExecutorOrUser,
  withRunnerAuth,
} from "@/lib/auth";
import {
  createAgent,
  createApiKey,
  createJob,
  createProject,
  createRun,
  createRunner,
  createSession,
  createUser,
  createWorkflow,
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

/** Build a request carrying a bearer token (exec token, runner token, or API key). */
function bearerReq(token: string, url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: `Bearer ${token}` },
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

// Common fixture: a project and a user. With a flat instance there are no
// roles — any authenticated user may do everything.
function fixture() {
  const project = createProject("Site")!;
  const user = createUser("u@x.com", "pw", "User")!;
  return { project, user };
}

// ===========================================================================
// withAuthenticatedUser
// ===========================================================================

describe("withAuthenticatedUser", () => {
  it("401 for an unauthenticated request", async () => {
    fixture();
    const handler = withAuthenticatedUser(ok);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
  });

  it("401 for a bogus session cookie", async () => {
    fixture();
    const handler = withAuthenticatedUser(ok);
    const req = new NextRequest("http://x/", {
      headers: { cookie: "harbour_session=not-a-session" },
    });
    expect((await handler(req, ctx({}))).status).toBe(401);
  });

  it("any signed-in user passes", async () => {
    const { user } = fixture();
    const handler = withAuthenticatedUser(ok);
    expect((await handler(userReq(user.id, "http://x/"), ctx({}))).status).toBe(200);
  });

  it("an API key acts as its creating user", async () => {
    const { user } = fixture();
    const { apiKey } = createApiKey("mgmt", user.id);
    let seen: string | undefined;
    const handler = withAuthenticatedUser((_req, auth) => {
      seen = auth.userId;
      return ok();
    });
    expect((await handler(bearerReq(apiKey, "http://x/"), ctx({}))).status).toBe(200);
    expect(seen).toBe(user.id);
  });

  it("403 for a run's exec token (user-only route)", async () => {
    const { project } = fixture();
    const { runId } = agentRun(project.id);
    const handler = withAuthenticatedUser(ok);
    expect((await handler(bearerReq(mintExecToken(runId), "http://x/"), ctx({}))).status).toBe(403);
  });

  it("403 for a runner token (user-only route)", async () => {
    fixture();
    const runner = createRunner({ name: "Local", tier: "local" });
    const handler = withAuthenticatedUser(ok);
    expect((await handler(bearerReq(runner.token, "http://x/"), ctx({}))).status).toBe(403);
  });
});

// ===========================================================================
// withRunnerAuth — the claim endpoint's wrapper
// ===========================================================================

describe("withRunnerAuth", () => {
  it("a runner token passes and carries the registry facts", async () => {
    fixture();
    const runner = createRunner({ name: "Box", tier: "remote", labels: ["gpu"] });
    let seen: { runnerId: string; tier: string; labels: string[] } | undefined;
    const handler = withRunnerAuth((_req, auth) => {
      seen = { runnerId: auth.runnerId, tier: auth.tier, labels: auth.labels };
      return ok();
    });
    expect((await handler(bearerReq(runner.token, "http://x/"), ctx({}))).status).toBe(200);
    expect(seen).toEqual({ runnerId: runner.id, tier: "remote", labels: ["gpu"] });
  });

  it("rejects users and executors (403) and anon (401)", async () => {
    const { project, user } = fixture();
    const { runId } = agentRun(project.id);
    const handler = withRunnerAuth(ok);
    expect((await handler(userReq(user.id, "http://x/"), ctx({}))).status).toBe(403);
    expect((await handler(bearerReq(mintExecToken(runId), "http://x/"), ctx({}))).status).toBe(403);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
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
    const handler = withRunExecutorOrUser(ok);
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
    const handler = withRunExecutorOrUser(ok);
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
    // reports terminal. (The resource-write gate lives on withAgentOrUser, below.)
    const handler = withRunExecutorOrUser(ok);
    const res = await handler(bearerReq(token, "http://x/"), ctx({ id: run.id }));
    expect(res.status).toBe(200);
  });

  it("any signed-in user passes; anon is 401; a runner token is 403", async () => {
    const { run, user } = runFixture();
    const runner = createRunner({ name: "Local", tier: "local" });
    const handler = withRunExecutorOrUser(ok);
    expect((await handler(userReq(user.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await handler(anonReq("http://x/"), ctx({ id: run.id }))).status).toBe(401);
    expect((await handler(bearerReq(runner.token, "http://x/"), ctx({ id: run.id }))).status).toBe(
      403,
    );
  });
});

// ===========================================================================
// withAgentOrUser — dual-identity resource routes
// ===========================================================================

describe("withAgentOrUser", () => {
  it("a signed-in user passes as a user identity", async () => {
    const { user } = fixture();
    let seen: AuthContext | undefined;
    const handler = withAgentOrUser((_req, auth) => {
      seen = auth;
      return ok();
    });
    expect((await handler(userReq(user.id, "http://x/"), ctx({}))).status).toBe(200);
    expect(seen?.type).toBe("user");
  });

  it("401 unauthenticated; 403 for a runner token", async () => {
    fixture();
    const runner = createRunner({ name: "Local", tier: "local" });
    const handler = withAgentOrUser(ok);
    expect((await handler(anonReq("http://x/"), ctx({}))).status).toBe(401);
    expect((await handler(bearerReq(runner.token, "http://x/"), ctx({}))).status).toBe(403);
  });

  it("an agent-run executor acts as its agent (agent + project identity)", async () => {
    const { project } = fixture();
    const { agent, runId } = agentRun(project.id);
    let seen: AuthContext | undefined;
    const handler = withAgentOrUser((_req, auth) => {
      seen = auth;
      return ok();
    });
    expect((await handler(bearerReq(mintExecToken(runId), "http://x/"), ctx({}))).status).toBe(200);
    expect(seen).toMatchObject({ type: "agent", agentId: agent.id, projectId: project.id });
  });

  it("a workflow run's executor has no agent identity and is rejected", async () => {
    const { project } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const run = createRun(wfJob.id, null)!;
    const handler = withAgentOrUser(ok);
    expect((await handler(bearerReq(mintExecToken(run.id), "http://x/"), ctx({}))).status).toBe(
      403,
    );
  });

  it("an agent-run executor acts as its agent while running, but is denied once terminal", async () => {
    const { project } = fixture();
    const { runId } = agentRun(project.id);
    const handler = withAgentOrUser(ok);

    // While the run executes, its exec token can write the agent's resources.
    const token = mintExecToken(runId);
    expect((await handler(bearerReq(token, "http://x/"), ctx({}))).status).toBe(200);

    // Once the run is terminal, a lingering/leaked token can no longer write
    // instance data (the executor goes inert for resource routes).
    updateRunStatus(runId, "done");
    expect((await handler(bearerReq(token, "http://x/"), ctx({}))).status).toBe(403);
  });
});
