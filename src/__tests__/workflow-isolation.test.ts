import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as activityPOST } from "@/app/api/runs/[id]/activity/route";
import { POST as retryPOST } from "@/app/api/runs/[id]/retry/route";

import { PUT as runStatusPUT } from "@/app/api/runs/[id]/status/route";
import {
  addMembership,
  createAgent,
  createJob,
  createOrg,
  createProject,
  createRun,
  createSession,
  createUser,
  createWorkflow,
  getRunById,
  listRunActivity,
  mintExecToken,
  updateRunStatus,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { claim, localRunner } from "./support/claim";

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

// A run's executor authenticates with that run's `hbx_` exec token (minted at
// claim). It's the only credential the activity/status routes accept as the
// run's executor — for both agent and workflow runs. The same exec token (acting
// as the agent) is what resource routes accept, and the old per-org
// workflow-runner key is gone.
function executorReq(execToken: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${execToken}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function statusBody(status: string): ReqInit {
  return {
    method: "PUT",
    body: JSON.stringify({ status }),
    headers: { "content-type": "application/json" },
  };
}

function commentBody(content: string): ReqInit {
  return {
    method: "POST",
    body: JSON.stringify({ content }),
    headers: { "content-type": "application/json" },
  };
}

// Fixture: one org with an agent run and a workflow run side by side.
function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  const viewer = createUser("v@x.com", "pw", "Viewer")!;
  addMembership(editor.id, org.id, "editor");
  addMembership(viewer.id, org.id, "viewer");
  const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
  const agentJob = createJob(project.id, agent.id, { name: "AJ", schedule: '{"every":60}' })!;
  const agentRun = createRun(agentJob.id, agent.id)!;
  // The run's executor credential — what the runner hands its spawned CLI for
  // this run's lifecycle endpoints (the same exec token, acting as the agent,
  // also reaches the resource routes).
  const agentExec = mintExecToken(agentRun.id);
  const wfJob = createWorkflow(org.id, project.id, {
    name: "WF",
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo hi" },
  })!;
  const wfRun = createRun(wfJob.id, null)!;
  // The workflow run is born 'running'; mint its executor token so route-level
  // tests can act as the run's executor (the runner's spawned process).
  const wfExec = mintExecToken(wfRun.id);
  return {
    org,
    project,
    editor,
    viewer,
    agent,
    agentJob,
    agentRun,
    agentExec,
    wfJob,
    wfRun,
    wfExec,
  };
}

describe("workflow run status isolation", () => {
  it("rejects 'waiting' on a workflow run from a workflow runner", async () => {
    const { wfRun, wfExec } = fixture();
    const res = await runStatusPUT(
      executorReq(wfExec, "http://x/", statusBody("waiting")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(400);
    expect(getRunById(wfRun.id)!.status).toBe("running");
  });

  it("rejects 'pending' on a workflow run from a workflow runner", async () => {
    const { wfRun, wfExec } = fixture();
    const res = await runStatusPUT(
      executorReq(wfExec, "http://x/", statusBody("pending")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(400);
    expect(getRunById(wfRun.id)!.status).toBe("running");
  });

  it("rejects 'waiting' on a workflow run from a user (editor)", async () => {
    const { wfRun, editor } = fixture();
    const res = await runStatusPUT(
      userReq(editor.id, "http://x/", statusBody("waiting")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(400);
    expect(getRunById(wfRun.id)!.status).toBe("running");
  });

  it("still accepts terminal statuses on a workflow run", async () => {
    const { project } = fixture();
    for (const status of ["done", "failed", "skipped", "killed"]) {
      const job = createWorkflow(project.org_id, project.id, {
        name: `WF-${status}`,
        schedule: '{"every":60}',
        workflow: { runtime: "bash", content: "echo hi" },
      })!;
      const run = createRun(job.id, null)!;
      const execToken = mintExecToken(run.id);
      const res = await runStatusPUT(
        executorReq(execToken, "http://x/", statusBody(status)),
        ctx({ id: run.id }),
      );
      expect(res.status, `status=${status}`).toBe(200);
      expect(getRunById(run.id)!.status).toBe(status);
    }
  });

  it("agent runs still accept 'waiting' (regression)", async () => {
    const { agentRun, agentExec } = fixture();
    const res = await runStatusPUT(
      executorReq(agentExec, "http://x/", statusBody("waiting")),
      ctx({ id: agentRun.id }),
    );
    expect(res.status).toBe(200);
    expect(getRunById(agentRun.id)!.status).toBe("waiting");
  });
});

describe("workflow runs have no message thread", () => {
  it("rejects a user comment on a workflow run (editor)", async () => {
    const { wfRun, editor } = fixture();
    updateRunStatus(wfRun.id, "failed"); // a state where agent runs would accept comments
    const res = await activityPOST(
      userReq(editor.id, "http://x/", commentBody("hello?")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(400);
    // No comment recorded, and the run must NOT flip to pending.
    expect(listRunActivity(wfRun.id).filter((a) => a.author_type === "user")).toHaveLength(0);
    expect(getRunById(wfRun.id)!.status).toBe("failed");
  });

  it("rejects a user comment on a workflow run (viewer)", async () => {
    const { wfRun, viewer } = fixture();
    updateRunStatus(wfRun.id, "done");
    const res = await activityPOST(
      userReq(viewer.id, "http://x/", commentBody("nice")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(400);
    expect(getRunById(wfRun.id)!.status).toBe("done");
  });

  it("records workflow-runner output with author_type 'workflow'", async () => {
    const { wfRun, wfExec } = fixture();
    const res = await activityPOST(
      executorReq(wfExec, "http://x/", commentBody("3 rows synced")),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(201);
    const entry = await res.json();
    expect(entry.author_type).toBe("workflow");
    // A workflow run has no agent, so its executor token carries no name; the
    // route authors workflow output under the generic "Runner" label. (The old
    // per-org workflow-runner key surfaced its registered name, e.g. "Server";
    // that link no longer exists in the unified-claim model.)
    expect(entry.author_name).toBe("Runner");
    // Round-trips through the CHECK constraint on run_activity.author_type.
    const stored = listRunActivity(wfRun.id);
    expect(stored.some((a) => a.author_type === "workflow" && a.content === "3 rows synced")).toBe(
      true,
    );
  });

  it("a user comment on a waiting agent run still moves it to pending (regression)", async () => {
    const { agentRun, editor } = fixture();
    updateRunStatus(agentRun.id, "waiting");
    const res = await activityPOST(
      userReq(editor.id, "http://x/", commentBody("approved, go ahead")),
      ctx({ id: agentRun.id }),
    );
    expect(res.status).toBe(201);
    const entry = await res.json();
    expect(entry.author_type).toBe("user");
    expect(getRunById(agentRun.id)!.status).toBe("pending");
  });

  it("an agent posting on its own run is still recorded as 'agent' (regression)", async () => {
    const { agentRun, agentExec } = fixture();
    const res = await activityPOST(
      executorReq(agentExec, "http://x/", commentBody("working on it")),
      ctx({ id: agentRun.id }),
    );
    expect(res.status).toBe(201);
    const entry = await res.json();
    expect(entry.author_type).toBe("agent");
  });
});

describe("workflow run retry requeues for the runner", () => {
  it("retrying a failed workflow run requeues it as 'scheduled', claimable by a runner", async () => {
    const { wfRun, editor } = fixture();
    updateRunStatus(wfRun.id, "failed");

    const res = await retryPOST(
      userReq(editor.id, "http://x/", { method: "POST" }),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(200);

    const after = getRunById(wfRun.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.scheduled_for).not.toBeNull();
    expect(after.scheduled_for).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    // The whole point: a runner can actually pick the retry back up. (The agent
    // run from the fixture is still 'running', so the requeued workflow run is
    // the only claimable unit here.)
    const payload = claim(localRunner());
    expect(payload).not.toBeNull();
    expect(payload!.run.id).toBe(wfRun.id);
    expect(getRunById(wfRun.id)!.status).toBe("running");
  });

  it("retrying a failed agent run still goes to 'pending' (regression)", async () => {
    const { agentRun, editor } = fixture();
    updateRunStatus(agentRun.id, "failed");
    const res = await retryPOST(
      userReq(editor.id, "http://x/", { method: "POST" }),
      ctx({ id: agentRun.id }),
    );
    expect(res.status).toBe(200);
    expect(getRunById(agentRun.id)!.status).toBe("pending");
  });

  it("a workflow run's executor cannot retry runs (user-only action)", async () => {
    const { wfRun, wfExec } = fixture();
    updateRunStatus(wfRun.id, "failed");
    // Retry is a dashboard (user) action — withResourceAuth, editor role. An
    // executor token is not a user, so it's forbidden from retrying.
    const res = await retryPOST(
      executorReq(wfExec, "http://x/", { method: "POST" }),
      ctx({ id: wfRun.id }),
    );
    expect(res.status).toBe(403);
    expect(getRunById(wfRun.id)!.status).toBe("failed");
  });
});

describe("schema: run_activity author types", () => {
  it("accepts 'workflow' and rejects unknown author types", () => {
    const db = getDb();
    const { wfRun } = fixture();
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES ('a1', ?, 'workflow', 'Server', 'ok')`,
        )
        .run(wfRun.id),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES ('a2', ?, 'robot', 'X', 'no')`,
        )
        .run(wfRun.id),
    ).toThrow();
  });

  it("rebuilds run_activity on databases created before 'workflow' was a valid author type", () => {
    const db = getDb();
    const { wfRun } = fixture();

    // Simulate an install created before this change: swap run_activity for
    // the old shape (CHECK without 'workflow') carrying an existing row.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE run_activity_old (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK(author_type IN ('agent','user','system')),
        author_id TEXT,
        author_name TEXT,
        content TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO run_activity_old SELECT id, run_id, author_type, author_id, author_name, content, created_at FROM run_activity;
      DROP TABLE run_activity;
      ALTER TABLE run_activity_old RENAME TO run_activity;
    `);
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES ('old1', ?, 'system', 'System', 'pre-upgrade row')`,
    ).run(wfRun.id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES ('x', ?, 'workflow', 'S', 'no')`,
        )
        .run(wfRun.id),
    ).toThrow();

    // Startup path: initializeSchema runs on every boot and must upgrade the
    // table in place without losing rows.
    initializeSchema(db);

    expect(db.prepare(`SELECT content FROM run_activity WHERE id = 'old1'`).get()).toMatchObject({
      content: "pre-upgrade row",
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_activity (id, run_id, author_type, author_name, content) VALUES ('new1', ?, 'workflow', 'Server', 'ok')`,
        )
        .run(wfRun.id),
    ).not.toThrow();

    // The rebuild must not lose the table's indexes.
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_activity'`)
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_run_activity_run");
    expect(names).toContain("idx_run_activity_run_time");
  });
});
