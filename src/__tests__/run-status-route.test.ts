import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { setDb, resetDb, initializeSchema } from "@/lib/db/schema";
import {
  createOrg,
  createProject,
  createUser,
  createAgent,
  createJob,
  createRun,
  addMembership,
  createSession,
  updateRunStatus,
  getRunById,
  listRunActivity,
} from "@/lib/db/queries";

import { PUT as runStatusPUT } from "@/app/api/runs/[id]/status/route";

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

function agentReq(apiKey: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function statusBody(status: string): ReqInit {
  return { method: "PUT", body: JSON.stringify({ status }), headers: { "content-type": "application/json" } };
}

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  addMembership(editor.id, org.id, "editor");
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "AJ", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!; // born 'running'
  return { org, project, editor, agent, job, run };
}

function statusActivity(runId: string) {
  return (listRunActivity(runId) as any[]).filter(
    (a) => a.author_type === "system" && /Status changed/.test(a.content || "")
  );
}

describe("PUT /api/runs/:id/status — lifecycle guard (HTTP layer)", () => {
  it("returns 409 (not 400) for a valid status that is an illegal transition", async () => {
    const { run, editor } = fixture();
    // running -> done is legal; done -> running is not.
    updateRunStatus(run.id, "done");
    const res = await runStatusPUT(userReq(editor.id, "http://x/", statusBody("running")), ctx({ id: run.id }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Cannot change run status from done to running");
    // The run is unchanged — the illegal write was rejected.
    expect(getRunById(run.id)!.status).toBe("done");
  });

  it("still returns 400 for a value outside the status enum", async () => {
    const { run, editor } = fixture();
    const res = await runStatusPUT(userReq(editor.id, "http://x/", statusBody("bogus")), ctx({ id: run.id }));
    expect(res.status).toBe(400);
    expect(getRunById(run.id)!.status).toBe("running");
  });

  it("permits the done -> failed override edge reserved for the postrun gate", async () => {
    const { run, editor } = fixture();
    updateRunStatus(run.id, "done");
    const res = await runStatusPUT(userReq(editor.id, "http://x/", statusBody("failed")), ctx({ id: run.id }));
    expect(res.status).toBe(200);
    expect(getRunById(run.id)!.status).toBe("failed");
  });
});

describe("PUT /api/runs/:id/status — activity logging", () => {
  it("logs a 'Status changed' activity on a real transition", async () => {
    const { run, agent } = fixture();
    const res = await runStatusPUT(agentReq(agent.apiKey, "http://x/", statusBody("done")), ctx({ id: run.id }));
    expect(res.status).toBe(200);
    const logged = statusActivity(run.id);
    expect(logged).toHaveLength(1);
    expect(logged[0].content).toContain("done");
  });

  it("does NOT log a 'Status changed' activity for a no-op self-transition", async () => {
    const { run, agent } = fixture(); // already 'running'
    const res = await runStatusPUT(agentReq(agent.apiKey, "http://x/", statusBody("running")), ctx({ id: run.id }));
    expect(res.status).toBe(200);
    expect(getRunById(run.id)!.status).toBe("running");
    // No state change happened, so no misleading "Status changed to running" entry.
    expect(statusActivity(run.id)).toHaveLength(0);
  });
});
