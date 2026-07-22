import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as runnerStatusGET } from "@/app/api/agents/[id]/runner-status/route";
import {
  createAgent,
  createProject,
  createRunner,
  createSession,
  createUser,
  touchRunnerPolled,
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

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function userReq(userId: string, url: string): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers();
  headers.set("cookie", `harbour_session=${sessionId}`);
  return new NextRequest(url, { headers });
}

function fixture() {
  const project = createProject("Site")!;
  const user = createUser("u@x.com", "pw", "User")!;
  const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", placement: "gpu" })!;
  return { project, user, agent };
}

describe("GET /api/agents/[id]/runner-status", () => {
  it("is false when no runner is live for the agent's placement + CLI", async () => {
    const { user, agent } = fixture();
    const res = await runnerStatusGET(
      userReq(user.id, "http://x/api/agents/1/runner-status"),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: false });
  });

  it("is true once a live runner advertises the agent's placement + CLI", async () => {
    const { user, agent } = fixture();
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });

    const res = await runnerStatusGET(
      userReq(user.id, "http://x/api/agents/1/runner-status"),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });

  it("404s for an unknown agent id", async () => {
    const { user } = fixture();
    const res = await runnerStatusGET(
      userReq(user.id, "http://x/api/agents/1/runner-status"),
      ctx({ id: "missing" }),
    );
    expect(res.status).toBe(404);
  });
});
