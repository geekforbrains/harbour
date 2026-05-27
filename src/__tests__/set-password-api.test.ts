import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { setDb, resetDb, initializeSchema, getDb } from "@/lib/db/schema";
import {
  createUser,
  createSession,
  createSetPasswordToken,
  getSetPasswordToken,
  authenticateUser,
} from "@/lib/db/queries";

import { POST as setPasswordPOST } from "@/app/api/auth/set-password/route";
import { POST as linkPOST } from "@/app/api/users/[id]/set-password-link/route";

// The set-password route is a plain `POST(req)` with no route params; wrap it so
// call sites read uniformly with the [id] route's (req, ctx) signature.
function callSetPassword(req: NextRequest) {
  return setPasswordPOST(req);
}

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

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ "Content-Type": "application/json", ...headers });
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: h });
}

function adminReq(userId: string, url: string) {
  const sessionId = createSession(userId);
  const h = new Headers({ cookie: `harbour_session=${sessionId}` });
  return new NextRequest(url, { method: "POST", headers: h });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/auth/set-password", () => {
  function makeUser(email = "user@example.com") {
    const u = createUser(email, null, "User") as { id: string };
    return u.id;
  }

  it("sets the password, consumes the token, and issues a session cookie", async () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    const res = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: rawToken, password: "newpassword1" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("harbour_session=");

    expect(authenticateUser("user@example.com", "newpassword1")).not.toBeNull();
    expect(getSetPasswordToken(rawToken)?.consumed_at).not.toBeNull();
  });

  it("rejects a too-short password without consuming the token", async () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    const res = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: rawToken, password: "short" })
    );
    expect(res.status).toBe(400);
    expect(getSetPasswordToken(rawToken)?.consumed_at).toBeNull();
  });

  it("rejects a missing token", async () => {
    const res = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { password: "newpassword1" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects an already-consumed token", async () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);

    const first = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: rawToken, password: "firstpass1" })
    );
    expect(first.status).toBe(200);

    const second = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: rawToken, password: "secondpass1" })
    );
    expect(second.status).toBe(400);
    // Password unchanged.
    expect(authenticateUser("user@example.com", "firstpass1")).not.toBeNull();
    expect(authenticateUser("user@example.com", "secondpass1")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const userId = makeUser();
    const { rawToken } = createSetPasswordToken(userId, null);
    getDb()
      .prepare(`UPDATE set_password_tokens SET expires_at = ?`)
      .run(Math.floor(Date.now() / 1000) - 10);

    const res = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: rawToken, password: "newpassword1" })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/users/:id/set-password-link", () => {
  function makeAdmin() {
    const u = createUser("admin@example.com", "adminpass1", "Admin", { isInstanceAdmin: true }) as {
      id: string;
    };
    return u.id;
  }

  it("instance admin mints a usable link; the returned token redeems", async () => {
    const adminId = makeAdmin();
    const target = createUser("target@example.com", null, "Target") as { id: string };

    const res = await linkPOST(
      adminReq(adminId, "http://localhost/api/users/x/set-password-link"),
      idParams(target.id)
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string; url: string };
    expect(data.token).toBeTruthy();
    expect(data.url).toContain("/set-password?token=");

    // The minted token actually works.
    const redeem = await callSetPassword(
      jsonReq("http://localhost/api/auth/set-password", { token: data.token, password: "freshpass1" })
    );
    expect(redeem.status).toBe(200);
    expect(authenticateUser("target@example.com", "freshpass1")).not.toBeNull();
  });

  it("non-admins are forbidden", async () => {
    const editor = createUser("editor@example.com", "editorpass1", "Editor") as { id: string };
    const target = createUser("target@example.com", null, "Target") as { id: string };

    const res = await linkPOST(
      adminReq(editor.id, "http://localhost/api/users/x/set-password-link"),
      idParams(target.id)
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown user", async () => {
    const adminId = makeAdmin();
    const res = await linkPOST(
      adminReq(adminId, "http://localhost/api/users/x/set-password-link"),
      idParams("no-such-user")
    );
    expect(res.status).toBe(404);
  });
});
