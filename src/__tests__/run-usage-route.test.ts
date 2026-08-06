import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as runUsagePOST } from "@/app/api/runs/[id]/usage/route";
import {
  createAgent,
  createJob,
  createProject,
  createRun,
  createSession,
  createUser,
  getRunById,
  mintExecToken,
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

// Usage is runner-reported: the route authenticates with the run's exec token
// (the runner/CLI credential), never a user session.
function execReq(runId: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${mintExecToken(runId)}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function usageBody(usage: unknown): ReqInit {
  return {
    method: "POST",
    body: JSON.stringify(usage),
    headers: { "content-type": "application/json" },
  };
}

function fixture() {
  const project = createProject("Site")!;
  const user = createUser("e@x.com", "pw", "Eve")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "AJ", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!; // born 'running'
  return { project, user, agent, job, run };
}

describe("POST /api/runs/:id/usage — accumulation", () => {
  it("folds each posted delta into the run's cumulative counters", async () => {
    const { run } = fixture();
    const first = await runUsagePOST(
      execReq(run.id, "http://x/", usageBody({ input_tokens: 77482, output_tokens: 154 })),
      ctx({ id: run.id }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const second = await runUsagePOST(
      execReq(run.id, "http://x/", usageBody({ input_tokens: 17977, output_tokens: 5 })),
      ctx({ id: run.id }),
    );
    expect(second.status).toBe(200);

    const row = getRunById(run.id)!;
    expect(row.input_tokens).toBe(95459);
    expect(row.output_tokens).toBe(159);
  });

  it("accepts a zero delta — a turn can bill nothing", async () => {
    const { run } = fixture();
    const res = await runUsagePOST(
      execReq(run.id, "http://x/", usageBody({ input_tokens: 0, output_tokens: 0 })),
      ctx({ id: run.id }),
    );
    expect(res.status).toBe(200);
    const row = getRunById(run.id)!;
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });
});

describe("POST /api/runs/:id/usage — auth", () => {
  it("rejects an exec token minted for a different run", async () => {
    const { run, job, agent } = fixture();
    const other = createRun(job.id, agent.id)!;
    const res = await runUsagePOST(
      execReq(other.id, "http://x/", usageBody({ input_tokens: 10, output_tokens: 1 })),
      ctx({ id: run.id }),
    );
    expect(res.status).toBe(403);
    expect(getRunById(run.id)!.input_tokens).toBe(0);
  });

  it("rejects a dashboard user — usage is runner-reported only", async () => {
    const { run, user } = fixture();
    const res = await runUsagePOST(
      userReq(user.id, "http://x/", usageBody({ input_tokens: 10, output_tokens: 1 })),
      ctx({ id: run.id }),
    );
    expect(res.status).toBe(403);
    expect(getRunById(run.id)!.input_tokens).toBe(0);
  });

  it("returns 404 for an unknown run (user auth reaches the handler's lookup)", async () => {
    const { user } = fixture();
    const res = await runUsagePOST(
      userReq(user.id, "http://x/", usageBody({ input_tokens: 10, output_tokens: 1 })),
      ctx({ id: "nope" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request", async () => {
    const { run } = fixture();
    const res = await runUsagePOST(
      new NextRequest("http://x/", usageBody({ input_tokens: 10, output_tokens: 1 })),
      ctx({ id: run.id }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/runs/:id/usage — validation (400, nothing persisted)", () => {
  const BAD_PAYLOADS: [string, unknown][] = [
    ["negative input_tokens", { input_tokens: -1, output_tokens: 5 }],
    ["float input_tokens", { input_tokens: 1.5, output_tokens: 5 }],
    ["missing input_tokens", { output_tokens: 5 }],
    ["missing output_tokens", { input_tokens: 5 }],
    ["string tokens", { input_tokens: "5", output_tokens: 5 }],
    ["non-object body", [1, 2]],
    // Integer-valued doubles pass Number.isInteger but bind as REAL in SQLite,
    // silently degrading the INTEGER counters (1e308 twice → Infinity → null
    // in JSON). Safe integers only.
    ["unsafe integer input_tokens", { input_tokens: 2 ** 53, output_tokens: 0 }],
    ["integer-valued double input_tokens", { input_tokens: 1e308, output_tokens: 0 }],
    // Per-post ceiling: a single CLI turn can't spend 1e10 tokens; caps keep
    // the cumulative int64 columns unreachable from overflow under abuse.
    ["input_tokens above the per-post cap", { input_tokens: 10_000_000_001, output_tokens: 0 }],
    ["output_tokens above the per-post cap", { input_tokens: 0, output_tokens: 10_000_000_001 }],
  ];

  for (const [label, payload] of BAD_PAYLOADS) {
    it(`rejects ${label}`, async () => {
      const { run } = fixture();
      const res = await runUsagePOST(
        execReq(run.id, "http://x/", usageBody(payload)),
        ctx({ id: run.id }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
      const row = getRunById(run.id)!;
      expect(row.input_tokens).toBe(0);
      expect(row.output_tokens).toBe(0);
    });
  }
});
