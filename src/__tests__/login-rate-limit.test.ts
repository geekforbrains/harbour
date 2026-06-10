import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { createUser } from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

const PASSWORD = "correcthorsebattery";

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  setDb(db);
  initializeSchema(db);
});

afterEach(() => {
  resetDb();
});

// The login limiter is module-level state shared across tests in this file, so
// each test uses a unique email/IP pair to keep its window isolated.
function loginReq(email: string, password: string, ip?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ip) headers.set("x-forwarded-for", ip);
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers,
  });
}

describe("POST /api/auth/login rate limiting", () => {
  it("returns 429 after 5 failed attempts for the same email + IP", async () => {
    const email = "block@example.com";
    createUser(email, PASSWORD, "U");

    for (let i = 0; i < 5; i++) {
      const res = await loginPOST(loginReq(email, "wrong-password", "1.1.1.1"));
      expect(res.status).toBe(401);
    }

    // Even the correct password is rejected once the window is exhausted.
    const blocked = await loginPOST(loginReq(email, PASSWORD, "1.1.1.1"));
    expect(blocked.status).toBe(429);
    const data = (await blocked.json()) as { error: string };
    expect(data.error).toBeTruthy();
  });

  it("a successful login clears the failure counter", async () => {
    const email = "clears@example.com";
    createUser(email, PASSWORD, "U");

    for (let i = 0; i < 4; i++) {
      await loginPOST(loginReq(email, "wrong-password", "2.2.2.2"));
    }
    const ok = await loginPOST(loginReq(email, PASSWORD, "2.2.2.2"));
    expect(ok.status).toBe(200);

    // Counter was cleared — 5 more failures are needed before a block.
    for (let i = 0; i < 4; i++) {
      const res = await loginPOST(loginReq(email, "wrong-password", "2.2.2.2"));
      expect(res.status).toBe(401);
    }
    const stillOk = await loginPOST(loginReq(email, PASSWORD, "2.2.2.2"));
    expect(stillOk.status).toBe(200);
  });

  it("keys on normalized email — case variants share a counter", async () => {
    const email = "case@example.com";
    createUser(email, PASSWORD, "U");

    for (let i = 0; i < 5; i++) {
      await loginPOST(loginReq("CASE@Example.COM", "wrong-password", "3.3.3.3"));
    }
    const blocked = await loginPOST(loginReq(email, PASSWORD, "3.3.3.3"));
    expect(blocked.status).toBe(429);
  });

  it("a different IP for the same email is not blocked", async () => {
    const email = "perip@example.com";
    createUser(email, PASSWORD, "U");

    for (let i = 0; i < 5; i++) {
      await loginPOST(loginReq(email, "wrong-password", "4.4.4.4"));
    }
    expect((await loginPOST(loginReq(email, PASSWORD, "4.4.4.4"))).status).toBe(429);
    expect((await loginPOST(loginReq(email, PASSWORD, "5.5.5.5"))).status).toBe(200);
  });

  it("a different email from the same IP is not blocked", async () => {
    const blockedEmail = "first@example.com";
    const otherEmail = "second@example.com";
    createUser(otherEmail, PASSWORD, "U");

    for (let i = 0; i < 5; i++) {
      await loginPOST(loginReq(blockedEmail, "wrong-password", "6.6.6.6"));
    }
    expect((await loginPOST(loginReq(otherEmail, PASSWORD, "6.6.6.6"))).status).toBe(200);
  });
});
