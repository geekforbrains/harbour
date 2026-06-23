import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as memberDELETE } from "@/app/api/orgs/[id]/members/[userId]/route";
import { POST as membersPOST } from "@/app/api/orgs/[id]/members/route";

import { POST as orgsPOST } from "@/app/api/orgs/route";
import { DELETE as userDELETE, PUT as userPUT } from "@/app/api/users/[id]/route";
import { GET as usersGET, POST as usersPOST } from "@/app/api/users/route";
import {
  createOrg,
  createSession,
  createUser,
  listMemberships,
  listOrgs,
  resolveAccess,
} from "@/lib/db/queries";
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

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function admin() {
  return createUser("admin@x.com", "pw", "Admin", { isInstanceAdmin: true })!;
}
function editor() {
  // A plain user (no instance admin). Used to assert non-admin forbidden paths.
  return createUser("e@x.com", "pw", "Editor")!;
}

describe("POST /api/orgs", () => {
  it("instance admin creates an org with timezone in settings", async () => {
    const a = admin();
    const res = await orgsPOST(
      userReq(a.id, "http://x/api/orgs", {
        method: "POST",
        body: { name: "Acme", timezone: "America/New_York" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Acme");
    expect(JSON.parse(body.settings).timezone).toBe("America/New_York");
    expect(listOrgs().length).toBe(1);
  });

  it("rejects a missing name", async () => {
    const a = admin();
    const res = await orgsPOST(
      userReq(a.id, "http://x/api/orgs", { method: "POST", body: {} }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });

  it("non-admin is forbidden", async () => {
    const e = editor();
    const res = await orgsPOST(
      userReq(e.id, "http://x/api/orgs", { method: "POST", body: { name: "Acme" } }),
      ctx({}),
    );
    expect(res.status).toBe(403);
    expect(listOrgs().length).toBe(0);
  });
});

describe("POST /api/users", () => {
  it("instance admin creates a password-less user", async () => {
    const a = admin();
    const res = await usersPOST(
      userReq(a.id, "http://x/api/users", {
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
    const a = admin();
    const res = await usersPOST(
      userReq(a.id, "http://x/api/users", { method: "POST", body: {} }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });

  it("non-admin is forbidden", async () => {
    const e = editor();
    const res = await usersPOST(
      userReq(e.id, "http://x/api/users", {
        method: "POST",
        body: { email: "new@x.com", displayName: "New" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/users (pending + memberships)", () => {
  it("returns pending flag and org memberships per user", async () => {
    const a = admin();
    const org = createOrg("Acme")!;
    const u = createUser("m@x.com", null, "Member")!;
    const { addMembership } = await import("@/lib/db/queries");
    addMembership(u.id, org.id, "viewer");

    const res = await usersGET(userReq(a.id, "http://x/api/users"), ctx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      pending: boolean;
      memberships: { org_id: string; role: string }[];
    }>;
    const member = body.find((x) => x.id === u.id)!;
    expect(member.pending).toBe(true);
    expect(member.memberships).toEqual([{ org_id: org.id, org_name: "Acme", role: "viewer" }]);
    const adminRow = body.find((x) => x.id === a.id)!;
    expect(adminRow.pending).toBe(false);
  });

  it("non-admin is forbidden", async () => {
    const e = editor();
    const res = await usersGET(userReq(e.id, "http://x/api/users"), ctx({}));
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/users/:id", () => {
  it("instance admin toggles is_instance_admin", async () => {
    const a = admin();
    const u = createUser("u@x.com", null, "U")!;
    const res = await userPUT(
      userReq(a.id, `http://x/api/users/${u.id}`, {
        method: "PUT",
        body: { isInstanceAdmin: true },
      }),
      ctx({ id: u.id }),
    );
    expect(res.status).toBe(200);
    expect(resolveAccess(u.id, "any-org")).toBe("instance_admin");
  });

  it("non-admin is forbidden", async () => {
    const e = editor();
    const u = createUser("u@x.com", null, "U")!;
    const res = await userPUT(
      userReq(e.id, `http://x/api/users/${u.id}`, {
        method: "PUT",
        body: { isInstanceAdmin: true },
      }),
      ctx({ id: u.id }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/users/:id", () => {
  it("instance admin deletes a user", async () => {
    const a = admin();
    const u = createUser("u@x.com", null, "U")!;
    const res = await userDELETE(
      userReq(a.id, `http://x/api/users/${u.id}`, { method: "DELETE" }),
      ctx({ id: u.id }),
    );
    expect(res.status).toBe(200);
    expect(getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(u.id)).toBeUndefined();
  });

  it("non-admin is forbidden", async () => {
    const e = editor();
    const u = createUser("u@x.com", null, "U")!;
    const res = await userDELETE(
      userReq(e.id, `http://x/api/users/${u.id}`, { method: "DELETE" }),
      ctx({ id: u.id }),
    );
    expect(res.status).toBe(403);
  });
});

describe("membership add/remove", () => {
  it("instance admin adds then removes a membership", async () => {
    const a = admin();
    const org = createOrg("Acme")!;
    const u = createUser("u@x.com", null, "U")!;

    const add = await membersPOST(
      userReq(a.id, `http://x/api/orgs/${org.id}/members`, {
        method: "POST",
        body: { userId: u.id, role: "editor" },
      }),
      ctx({ id: org.id }),
    );
    expect(add.status).toBe(201);
    expect(resolveAccess(u.id, org.id)).toBe("editor");
    expect(listMemberships(org.id).length).toBe(1);

    const rm = await memberDELETE(
      userReq(a.id, `http://x/api/orgs/${org.id}/members/${u.id}`, { method: "DELETE" }),
      ctx({ id: org.id, userId: u.id }),
    );
    expect(rm.status).toBe(200);
    expect(resolveAccess(u.id, org.id)).toBeNull();
  });

  it("rejects adding a membership for an instance admin", async () => {
    const a = admin();
    const org = createOrg("Acme")!;
    const otherAdmin = createUser("a2@x.com", "pw", "A2", { isInstanceAdmin: true })!;
    const res = await membersPOST(
      userReq(a.id, `http://x/api/orgs/${org.id}/members`, {
        method: "POST",
        body: { userId: otherAdmin.id, role: "editor" },
      }),
      ctx({ id: org.id }),
    );
    expect(res.status).toBe(400);
    expect(listMemberships(org.id).length).toBe(0);
  });

  it("rejects an invalid role", async () => {
    const a = admin();
    const org = createOrg("Acme")!;
    const u = createUser("u@x.com", null, "U")!;
    const res = await membersPOST(
      userReq(a.id, `http://x/api/orgs/${org.id}/members`, {
        method: "POST",
        body: { userId: u.id, role: "owner" },
      }),
      ctx({ id: org.id }),
    );
    expect(res.status).toBe(400);
  });

  it("non-admin is forbidden on add", async () => {
    const e = editor();
    const org = createOrg("Acme")!;
    const u = createUser("u@x.com", null, "U")!;
    const res = await membersPOST(
      userReq(e.id, `http://x/api/orgs/${org.id}/members`, {
        method: "POST",
        body: { userId: u.id, role: "editor" },
      }),
      ctx({ id: org.id }),
    );
    expect(res.status).toBe(403);
  });

  it("non-admin is forbidden on remove", async () => {
    const e = editor();
    const org = createOrg("Acme")!;
    const u = createUser("u@x.com", null, "U")!;
    const res = await memberDELETE(
      userReq(e.id, `http://x/api/orgs/${org.id}/members/${u.id}`, { method: "DELETE" }),
      ctx({ id: org.id, userId: u.id }),
    );
    expect(res.status).toBe(403);
  });
});
