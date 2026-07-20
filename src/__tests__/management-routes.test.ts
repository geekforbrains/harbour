import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as apiKeyDELETE } from "@/app/api/api-keys/[id]/route";
import { GET as apiKeysGET, POST as apiKeysPOST } from "@/app/api/api-keys/route";
import { DELETE as runnerDELETE } from "@/app/api/runners/[id]/route";
import { GET as runnersGET, POST as runnersPOST } from "@/app/api/runners/route";
import { DELETE as userDELETE, PUT as userPUT } from "@/app/api/users/[id]/route";
import { GET as usersGET, POST as usersPOST } from "@/app/api/users/route";
import { createAgent, createProject, createSession, createUser } from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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

type ReqInit = { method?: string; body?: unknown; headers?: HeadersInit };

function userReq(userId: string, url: string, init: ReqInit = {}): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers(init.headers);
  headers.set("cookie", `harbour_session=${sessionId}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, {
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
  });
}

/** A request authenticated by a bearer token (here: an `hbr_…` API key). */
function bearerReq(token: string, url: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

// Any authenticated user may manage the instance — there are no roles.
function user() {
  return createUser("u@x.com", "pw", "User")!;
}

describe("POST /api/users", () => {
  it("creates a password-less user", async () => {
    const u = user();
    const res = await usersPOST(
      userReq(u.id, "http://x/api/users", {
        method: "POST",
        body: { email: "new@x.com", displayName: "New" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("new@x.com");
    // password_hash is NULL — the row exists but can't log in yet.
    const row = getDb().prepare(`SELECT password_hash FROM users WHERE id = ?`).get(body.id) as {
      password_hash: string | null;
    };
    expect(row.password_hash).toBeNull();
  });

  it("rejects a missing email", async () => {
    const u = user();
    const res = await usersPOST(
      userReq(u.id, "http://x/api/users", { method: "POST", body: {} }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an already-registered email with 409", async () => {
    const u = user(); // occupies u@x.com
    const res = await usersPOST(
      userReq(u.id, "http://x/api/users", {
        method: "POST",
        body: { email: "u@x.com", displayName: "Dup" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A user with this email already exists");
  });
});

describe("GET /api/users", () => {
  it("returns a flat list with a pending flag per user", async () => {
    const u = user();
    const invited = createUser("m@x.com", null, "Member")!;

    const res = await usersGET(userReq(u.id, "http://x/api/users"), ctx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; pending: boolean }>;
    expect(body.find((x) => x.id === invited.id)!.pending).toBe(true);
    expect(body.find((x) => x.id === u.id)!.pending).toBe(false);
  });
});

describe("PUT /api/users/:id", () => {
  it("renames a user", async () => {
    const u = user();
    const target = createUser("t@x.com", null, "Target")!;
    const res = await userPUT(
      userReq(u.id, `http://x/api/users/${target.id}`, {
        method: "PUT",
        body: { displayName: "Renamed" },
      }),
      ctx({ id: target.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).display_name).toBe("Renamed");
  });

  it("404 for an unknown user", async () => {
    const u = user();
    const res = await userPUT(
      userReq(u.id, "http://x/api/users/ghost", { method: "PUT", body: { displayName: "X" } }),
      ctx({ id: "ghost" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/users/:id", () => {
  it("deletes a user", async () => {
    const u = user();
    const target = createUser("t@x.com", null, "Target")!;
    const res = await userDELETE(
      userReq(u.id, `http://x/api/users/${target.id}`, { method: "DELETE" }),
      ctx({ id: target.id }),
    );
    expect(res.status).toBe(200);
    expect(getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(target.id)).toBeUndefined();
  });

  it("refuses to delete the last remaining user", async () => {
    const u = user();
    const res = await userDELETE(
      userReq(u.id, `http://x/api/users/${u.id}`, { method: "DELETE" }),
      ctx({ id: u.id }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot delete the last user");
    expect(getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(u.id)).toBeTruthy();
  });

  it("404 for an unknown user", async () => {
    const u = user();
    const res = await userDELETE(
      userReq(u.id, "http://x/api/users/ghost", { method: "DELETE" }),
      ctx({ id: "ghost" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("/api/runners (mint remote runner credentials)", () => {
  it("mints a labeled, agent-scoped remote runner; the connect blob decodes to {url,token,name}", async () => {
    const u = user();
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Dev");
    const res = await runnersPOST(
      userReq(u.id, "http://x/api/runners", {
        method: "POST",
        body: { name: "GPU box", labels: ["gpu"], scope: { agentId: agent.id } },
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tier).toBe("remote");
    expect(body.labels).toEqual(["gpu"]);
    expect(body.scope).toEqual({ agentId: agent.id });
    expect(body.token).toMatch(/^hbrn_/);
    expect(body.connect).toMatch(/^npm run harbour-agent -- connect /);
    const blob = body.connect.replace("npm run harbour-agent -- connect ", "");
    const decoded = JSON.parse(Buffer.from(blob, "base64").toString("utf-8"));
    expect(decoded).toMatchObject({ token: body.token, name: "GPU box" });
    expect(typeof decoded.url).toBe("string");
  });

  it("lists runners (no token leaks) and revokes one", async () => {
    const u = user();
    const minted = await (
      await runnersPOST(
        userReq(u.id, "http://x/api/runners", { method: "POST", body: { name: "Box" } }),
        ctx({}),
      )
    ).json();

    const listRes = await runnersGET(userReq(u.id, "http://x/api/runners"), ctx({}));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((r: { id: string }) => r.id === minted.id)).toBe(true);
    for (const r of list) expect(r.token).toBeUndefined();

    const del = await runnerDELETE(
      userReq(u.id, "http://x/", { method: "DELETE" }),
      ctx({ id: minted.id }),
    );
    expect(del.status).toBe(200);
    const after = await (await runnersGET(userReq(u.id, "http://x/api/runners"), ctx({}))).json();
    expect(after.some((r: { id: string }) => r.id === minted.id)).toBe(false);
  });

  it("404 when revoking an unknown runner", async () => {
    const u = user();
    const res = await runnerDELETE(
      userReq(u.id, "http://x/", { method: "DELETE" }),
      ctx({ id: "ghost" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("/api/api-keys", () => {
  it("mints a key with the hbr_ prefix; the raw key is returned exactly once", async () => {
    const u = user();
    const res = await apiKeysPOST(
      userReq(u.id, "http://x/api/api-keys", { method: "POST", body: { name: "mgmt" } }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("mgmt");
    expect(body.apiKey).toMatch(/^hbr_/);

    // The list never re-surfaces key material — only metadata.
    const list = await (await apiKeysGET(userReq(u.id, "http://x/api/api-keys"), ctx({}))).json();
    const row = list.find((k: { id: string }) => k.id === body.id);
    expect(row).toMatchObject({ name: "mgmt", created_by: "User" });
    expect(row.apiKey).toBeUndefined();
    expect(row.api_key_hash).toBeUndefined();
  });

  it("rejects a missing name", async () => {
    const u = user();
    const res = await apiKeysPOST(
      userReq(u.id, "http://x/api/api-keys", { method: "POST", body: {} }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });

  it("a key acts as its creating user until deleted (then 401s)", async () => {
    const u = user();
    const { id, apiKey } = await (
      await apiKeysPOST(
        userReq(u.id, "http://x/api/api-keys", { method: "POST", body: { name: "mgmt" } }),
        ctx({}),
      )
    ).json();

    // Bearer key on a user route resolves to the creating user's identity.
    const asKey = await usersGET(bearerReq(apiKey, "http://x/api/users"), ctx({}));
    expect(asKey.status).toBe(200);

    const del = await apiKeyDELETE(userReq(u.id, "http://x/", { method: "DELETE" }), ctx({ id }));
    expect(del.status).toBe(200);
    const revoked = await usersGET(bearerReq(apiKey, "http://x/api/users"), ctx({}));
    expect(revoked.status).toBe(401);
  });

  it("deleting an unknown key id is a 404", async () => {
    const u = user();
    const res = await apiKeyDELETE(
      userReq(u.id, "http://x/", { method: "DELETE" }),
      ctx({ id: "ghost" }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("API key not found");
  });
});
