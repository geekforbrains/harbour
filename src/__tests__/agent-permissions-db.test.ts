import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUT as agentPUT } from "@/app/api/agents/[id]/route";
import { POST as agentsPOST } from "@/app/api/agents/route";
import { AGENT_PERMISSIONS, normalizePermissions, validatePermissions } from "@/lib/cli-config";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createProject,
  createRun,
  createSession,
  createUser,
  getAgentById,
  listAgents,
  updateAgent,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// The agents.permissions column governs whether the runner may launch the
// agent's CLI with its permission-bypass flag. The storage rule is fail-closed:
// only the exact string 'unrestricted' is ever persisted as 'unrestricted' —
// anything else (absent, junk, wrong case) stores 'enforced'. These tests lock
// that rule at every write path plus the claim payload that carries it to the
// runner.

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

let seq = 0;

function userReq(url: string, method: string, body: unknown): NextRequest {
  const user = createUser(`u${seq++}@x.com`, "pw", "User")!;
  const sessionId = createSession(user.id);
  const headers = new Headers({ cookie: `harbour_session=${sessionId}` });
  return new NextRequest(url, { method, body: JSON.stringify(body), headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

describe("validatePermissions / normalizePermissions", () => {
  it("accepts exactly the documented values", () => {
    for (const value of AGENT_PERMISSIONS) {
      expect(validatePermissions(value)).toBeNull();
    }
  });

  it("rejects anything else, naming the valid options", () => {
    const error = validatePermissions("bypass");
    expect(error).toMatch(/bypass/);
    expect(error).toMatch(/enforced/);
    expect(error).toMatch(/unrestricted/);
    expect(validatePermissions("")).toBeTruthy();
    expect(validatePermissions(null)).toBeTruthy();
    expect(validatePermissions(undefined)).toBeTruthy();
  });

  it("normalizes fail-closed: only the exact 'unrestricted' passes through", () => {
    expect(normalizePermissions("unrestricted")).toBe("unrestricted");
    expect(normalizePermissions("enforced")).toBe("enforced");
    expect(normalizePermissions("Unrestricted")).toBe("enforced");
    expect(normalizePermissions("junk")).toBe("enforced");
    expect(normalizePermissions(undefined)).toBe("enforced");
    expect(normalizePermissions(null)).toBe("enforced");
  });
});

describe("agents.permissions storage", () => {
  it("defaults to 'enforced' on create", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    expect(agent.permissions).toBe("enforced");
    expect(getAgentById(agent.id)?.permissions).toBe("enforced");
  });

  it("round-trips an explicit 'unrestricted' through create, get, and list", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, {
      cli: "claude",
      permissions: "unrestricted",
    });
    expect(agent.permissions).toBe("unrestricted");
    expect(getAgentById(agent.id)?.permissions).toBe("unrestricted");
    expect(listAgents(project.id).find((a) => a.id === agent.id)?.permissions).toBe("unrestricted");
  });

  it("stores 'enforced' for a junk value on create (fail closed)", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, {
      cli: "claude",
      permissions: "UNRESTRICTED",
    });
    expect(agent.permissions).toBe("enforced");
  });

  it("updateAgent flips the value in both directions and normalizes junk", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });

    expect(updateAgent(agent.id, { permissions: "unrestricted" })?.permissions).toBe(
      "unrestricted",
    );
    expect(updateAgent(agent.id, { permissions: "enforced" })?.permissions).toBe("enforced");
    // A junk value written through the db layer still lands fail-closed.
    updateAgent(agent.id, { permissions: "unrestricted" });
    expect(updateAgent(agent.id, { permissions: "junk" })?.permissions).toBe("enforced");
  });

  it("rows predating the column read as 'enforced' via the DDL default", () => {
    // Simulates the documented upgrade path: ALTER TABLE ... DEFAULT 'enforced'
    // backfills existing rows, so a bare INSERT (no permissions) must read back
    // enforced.
    const project = createProject("Website")!;
    getDb()
      .prepare(`INSERT INTO agents (id, project_id, name, slug) VALUES ('a1', ?, 'Old', 'old')`)
      .run(project.id);
    expect(getAgentById("a1")?.permissions).toBe("enforced");
  });
});

describe("claim payload carries permissions", () => {
  it("includes the agent's live permissions in the agent block", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, {
      cli: "claude",
      permissions: "unrestricted",
    });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    const before = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(before.agent?.permissions).toBe("unrestricted");

    // A dashboard flip reaches the runner on the very next claim — read live,
    // like cli/model/thinking.
    updateAgent(agent.id, { permissions: "enforced" });
    const after = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(after.agent?.permissions).toBe("enforced");
  });

  it("normalizes a junk stored value to 'enforced' in the payload (fail closed)", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    // Bypass the write-path normalization to prove the read path fails closed too.
    getDb().prepare(`UPDATE agents SET permissions = 'junk' WHERE id = ?`).run(agent.id);

    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.agent?.permissions).toBe("enforced");
  });
});

describe("POST /api/agents — permissions validation", () => {
  it("defaults to 'enforced' when omitted", async () => {
    const project = createProject("Site")!;
    const res = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "claude",
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).permissions).toBe("enforced");
  });

  it("accepts an explicit 'unrestricted'", async () => {
    const project = createProject("Site")!;
    const res = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "claude",
        permissions: "unrestricted",
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).permissions).toBe("unrestricted");
  });

  it("rejects an unknown value with a 400", async () => {
    const project = createProject("Site")!;
    const res = await agentsPOST(
      userReq(`http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "claude",
        permissions: "bypass",
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bypass/);
  });
});

describe("PUT /api/agents/:id — permissions validation", () => {
  it("flips the value and leaves other fields untouched", async () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const res = await agentPUT(
      userReq(`http://x/api/agents/${agent.id}`, "PUT", { permissions: "unrestricted" }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).permissions).toBe("unrestricted");
    expect(getAgentById(agent.id)?.cli).toBe("claude");
  });

  it("rejects an unknown value with a 400 and leaves the agent unchanged", async () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Dev", undefined, {
      cli: "claude",
      permissions: "unrestricted",
    });
    const res = await agentPUT(
      userReq(`http://x/api/agents/${agent.id}`, "PUT", { permissions: "yolo" }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/yolo/);
    expect(getAgentById(agent.id)?.permissions).toBe("unrestricted");
  });
});
