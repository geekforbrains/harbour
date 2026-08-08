import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentTablesPOST } from "@/app/api/agents/[id]/tables/route";
import { POST as columnsPOST } from "@/app/api/tables/[id]/columns/route";
import { POST as tablesPOST } from "@/app/api/tables/route";
import { addColumn, createAgent, createProject, createSession, createUser } from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { createTable } from "@/lib/db/tables";

// Column `type` and `default` are interpolated into CREATE TABLE / ALTER TABLE
// text that runs through db.exec(), which executes EVERY statement in the
// string. Validation therefore has to live in tables.ts — a per-route
// allow-list is one forgotten route away from arbitrary DDL, which is exactly
// how POST /api/agents/:id/tables ended up unguarded.

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

function fixture() {
  const project = createProject("Site")!;
  const user = createUser("u@x.com", "pw", "User")!;
  const agent = createAgent(project.id, "Dev");
  return { project, user, agent };
}

function userReq(userId: string, url: string, body?: string): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers();
  headers.set("cookie", `harbour_session=${sessionId}`);
  headers.set("content-type", "application/json");
  return new NextRequest(url, { method: "POST", headers, body });
}

// biome-ignore lint/suspicious/noExplicitAny: route ctx shape
const ctx = (params: Record<string, string>): any => ({ params: Promise.resolve(params) });

/** A bystander table an injected `DROP TABLE` would take out. */
function seedCanary() {
  const db = getDb();
  db.exec(`CREATE TABLE canary (id TEXT); INSERT INTO canary VALUES ('alive');`);
}

function canaryAlive(): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canary'`)
    .get();
  return row !== undefined;
}

describe("createTable DDL validation", () => {
  it("rejects an unsupported column type instead of running it as DDL", () => {
    const { project } = fixture();
    seedCanary();
    expect(() =>
      createTable(project.id, "evil", [
        { name: "c", type: "TEXT); DROP TABLE canary; --" as never },
      ]),
    ).toThrow(/column type/i);
    expect(canaryAlive()).toBe(true);
  });

  it("rejects a non-scalar default instead of interpolating it bare", () => {
    const { project } = fixture();
    seedCanary();
    expect(() =>
      createTable(project.id, "evil2", [
        { name: "c", type: "TEXT", default: ["1); DROP TABLE canary; --"] as never },
      ]),
    ).toThrow(/default/i);
    expect(canaryAlive()).toBe(true);
  });

  it("rejects an object default", () => {
    const { project } = fixture();
    expect(() =>
      createTable(project.id, "evil3", [
        { name: "c", type: "TEXT", default: { toString: "x" } as never },
      ]),
    ).toThrow(/default/i);
  });

  it("rejects a non-finite numeric default", () => {
    const { project } = fixture();
    expect(() =>
      createTable(project.id, "evil4", [{ name: "c", type: "TEXT", default: Number.NaN }]),
    ).toThrow(/default/i);
  });

  it("normalizes a lowercase type and still creates the table", () => {
    const { project } = fixture();
    const t = createTable(project.id, "ok", [{ name: "c", type: "text" as never }]);
    expect(t.columns.find((c) => c.name === "c")?.type).toBe("TEXT");
  });

  it("accepts string and numeric defaults, escaping quotes", () => {
    const { project } = fixture();
    const t = createTable(project.id, "ok2", [
      { name: "s", type: "TEXT", default: "it's fine" },
      { name: "n", type: "INTEGER", default: 42 },
    ]);
    expect(t.columns.map((c) => c.name).sort()).toEqual(["n", "s"]);
  });
});

describe("addColumn DDL validation", () => {
  it("rejects an unsupported column type", () => {
    const { project } = fixture();
    seedCanary();
    const t = createTable(project.id, "t1", [{ name: "a", type: "TEXT" }]);
    expect(() =>
      addColumn(t.id, { name: "b", type: "TEXT); DROP TABLE canary; --" as never }),
    ).toThrow(/column type/i);
    expect(canaryAlive()).toBe(true);
  });

  it("rejects a non-scalar default", () => {
    const { project } = fixture();
    seedCanary();
    const t = createTable(project.id, "t2", [{ name: "a", type: "TEXT" }]);
    expect(() =>
      addColumn(t.id, {
        name: "b",
        type: "TEXT",
        default: ["1); DROP TABLE canary; --"] as never,
      }),
    ).toThrow(/default/i);
    expect(canaryAlive()).toBe(true);
  });
});

describe("table routes reject injected DDL with a 400", () => {
  it("POST /api/agents/:id/tables rejects a bad column type", async () => {
    const { user, agent } = fixture();
    seedCanary();
    const req = userReq(
      user.id,
      `http://localhost/api/agents/${agent.id}/tables`,
      JSON.stringify({
        name: "evil",
        columns: [{ name: "c", type: "TEXT); DROP TABLE canary; --" }],
      }),
    );
    const res = await agentTablesPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
    expect(canaryAlive()).toBe(true);
  });

  it("POST /api/agents/:id/tables rejects a non-scalar default", async () => {
    const { user, agent } = fixture();
    seedCanary();
    const req = userReq(
      user.id,
      `http://localhost/api/agents/${agent.id}/tables`,
      JSON.stringify({
        name: "evil",
        columns: [{ name: "c", type: "TEXT", default: ["1); DROP TABLE canary; --"] }],
      }),
    );
    const res = await agentTablesPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(400);
    expect(canaryAlive()).toBe(true);
  });

  it("POST /api/tables rejects a non-scalar default", async () => {
    const { user, project } = fixture();
    seedCanary();
    const req = userReq(
      user.id,
      `http://localhost/api/tables?projectId=${project.id}`,
      JSON.stringify({
        name: "evil",
        columns: [{ name: "c", type: "TEXT", default: ["1); DROP TABLE canary; --"] }],
      }),
    );
    const res = await tablesPOST(req, ctx({}));
    expect(res.status).toBe(400);
    expect(canaryAlive()).toBe(true);
  });

  it("POST /api/tables/:id/columns rejects a non-scalar default", async () => {
    const { user, project } = fixture();
    seedCanary();
    const t = createTable(project.id, "t3", [{ name: "a", type: "TEXT" }]);
    const req = userReq(
      user.id,
      `http://localhost/api/tables/${t.id}/columns`,
      JSON.stringify({ name: "b", type: "TEXT", default: ["1); DROP TABLE canary; --"] }),
    );
    const res = await columnsPOST(req, ctx({ id: t.id }));
    expect(res.status).toBe(400);
    expect(canaryAlive()).toBe(true);
  });

  it("POST /api/agents/:id/tables still creates a valid table", async () => {
    const { user, agent } = fixture();
    const req = userReq(
      user.id,
      `http://localhost/api/agents/${agent.id}/tables`,
      JSON.stringify({ name: "good", columns: [{ name: "c", type: "TEXT" }] }),
    );
    const res = await agentTablesPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(201);
  });
});
