import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { PUT as agentPUT } from "@/app/api/agents/[id]/route";
import { POST as agentsPOST } from "@/app/api/agents/route";
import { PUT as jobPUT } from "@/app/api/jobs/[id]/route";
import { CLI_CONFIG, validateCli, validateThinking } from "@/lib/cli-config";
import {
  addMembership,
  createAgent,
  createJob,
  createOrg,
  createProject,
  createSession,
  createUser,
  createWorkflow,
  getAgentById,
  getJobById,
} from "@/lib/db/queries";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// Issue #39: an agent created over the API with `thinking: "off"` failed every
// run at CLI launch (`--effort off` is not a level claude accepts). The
// dashboard select is constrained by CLI_CONFIG but the API was not — these
// tests lock validation at every write path so a bad level is a 400 at write
// time, not a failed run hours later.

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

function editorReq(orgId: string, url: string, method: string, body: unknown): NextRequest {
  const editor = createUser(`e${seq++}@x.com`, "pw", "Editor")!;
  addMembership(editor.id, orgId, "editor");
  const sessionId = createSession(editor.id);
  const headers = new Headers({ cookie: `harbour_session=${sessionId}` });
  return new NextRequest(url, { method, body: JSON.stringify(body), headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  return { org, project };
}

describe("validateCli", () => {
  it("accepts every cli in CLI_CONFIG", () => {
    for (const cli of Object.keys(CLI_CONFIG)) {
      expect(validateCli(cli)).toBeNull();
    }
  });

  it("rejects an unknown or missing cli", () => {
    expect(validateCli("cursor")).toMatch(/cursor/);
    expect(validateCli(null)).toBeTruthy();
    expect(validateCli(undefined)).toBeTruthy();
  });
});

describe("validateThinking", () => {
  it("accepts every documented level for its cli", () => {
    for (const [cli, config] of Object.entries(CLI_CONFIG)) {
      for (const level of config.thinkingOptions) {
        expect(validateThinking(cli, level)).toBeNull();
      }
    }
  });

  it("treats empty as 'use the CLI default' and always allows it", () => {
    expect(validateThinking("claude", "")).toBeNull();
    expect(validateThinking("claude", null)).toBeNull();
    expect(validateThinking("claude", undefined)).toBeNull();
    expect(validateThinking("gemini", "")).toBeNull();
  });

  it("rejects a level the cli does not accept, naming the valid ones", () => {
    const error = validateThinking("claude", "off");
    expect(error).toMatch(/off/);
    expect(error).toMatch(/low/);
    expect(validateThinking("codex", "max")).toBeTruthy();
  });

  it("rejects any level for a cli with no thinking flag", () => {
    expect(validateThinking("gemini", "high")).toBeTruthy();
  });

  it("rejects a level when there is no valid cli to validate against", () => {
    expect(validateThinking(null, "high")).toBeTruthy();
    expect(validateThinking("cursor", "high")).toBeTruthy();
  });
});

describe("POST /api/agents — config validation", () => {
  it("rejects an unknown thinking level (the 'off' case)", async () => {
    const { org, project } = fixture();
    const res = await agentsPOST(
      editorReq(org.id, `http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Triage",
        cli: "claude",
        thinking: "off",
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/off/);
  });

  it("rejects an unknown cli", async () => {
    const { org, project } = fixture();
    const res = await agentsPOST(
      editorReq(org.id, `http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "cursor",
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cursor/);
  });

  it("accepts a valid cli + thinking", async () => {
    const { org, project } = fixture();
    const res = await agentsPOST(
      editorReq(org.id, `http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "claude",
        thinking: "max",
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).thinking).toBe("max");
  });

  it("accepts an omitted thinking (CLI default)", async () => {
    const { org, project } = fixture();
    const res = await agentsPOST(
      editorReq(org.id, `http://x/api/agents?projectId=${project.id}`, "POST", {
        name: "Dev",
        cli: "claude",
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
  });
});

describe("PUT /api/agents/:id — config validation", () => {
  it("rejects an unknown thinking level and leaves the agent unchanged", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", thinking: "high" });
    const res = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", { thinking: "off" }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(400);
    expect(getAgentById(agent.id)?.thinking).toBe("high");
  });

  it("accepts a valid level and clears with an empty string", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", thinking: "high" });

    const set = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", { thinking: "xhigh" }),
      ctx({ id: agent.id }),
    );
    expect(set.status).toBe(200);
    expect(getAgentById(agent.id)?.thinking).toBe("xhigh");

    const clear = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", { thinking: "" }),
      ctx({ id: agent.id }),
    );
    expect(clear.status).toBe(200);
    expect(getAgentById(agent.id)?.thinking).toBeNull();
  });

  it("rejects an unknown cli", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const res = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", { cli: "cursor" }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a cli change that strands the current thinking level", async () => {
    const { org, project } = fixture();
    // "max" is valid for claude but not codex — switching cli alone would
    // leave a level the new CLI rejects at launch.
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", thinking: "max" });
    const res = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", { cli: "codex" }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(400);
    expect(getAgentById(agent.id)?.cli).toBe("claude");
  });

  it("accepts a cli change that re-sets or clears thinking in the same request", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", thinking: "max" });
    const res = await agentPUT(
      editorReq(org.id, `http://x/api/agents/${agent.id}`, "PUT", {
        cli: "codex",
        thinking: "xhigh",
      }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(200);
    expect(getAgentById(agent.id)?.cli).toBe("codex");
    expect(getAgentById(agent.id)?.thinking).toBe("xhigh");
  });
});

describe("POST /api/agents/:id/jobs — thinking override validation", () => {
  it("rejects an override the agent's cli does not accept", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const res = await agentJobsPOST(
      editorReq(org.id, `http://x/api/agents/${agent.id}/jobs`, "POST", {
        name: "Build",
        schedule: '{"every":60}',
        thinking: "off",
      }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/off/);
  });

  it("accepts a valid override", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const res = await agentJobsPOST(
      editorReq(org.id, `http://x/api/agents/${agent.id}/jobs`, "POST", {
        name: "Build",
        schedule: '{"every":60}',
        thinking: "low",
      }),
      ctx({ id: agent.id }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).thinking).toBe("low");
  });
});

describe("PUT /api/jobs/:id — thinking override validation", () => {
  it("rejects an unknown thinking level and leaves the job unchanged", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, {
      name: "Build",
      schedule: '{"every":60}',
      thinking: "high",
    })!;
    const res = await jobPUT(
      editorReq(org.id, `http://x/api/jobs/${job.id}`, "PUT", { thinking: "off" }),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(400);
    expect(getJobById(job.id)?.thinking).toBe("high");
  });

  it("accepts a valid level and clears with an empty string", async () => {
    const { org, project } = fixture();
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    const set = await jobPUT(
      editorReq(org.id, `http://x/api/jobs/${job.id}`, "PUT", { thinking: "high" }),
      ctx({ id: job.id }),
    );
    expect(set.status).toBe(200);
    expect(getJobById(job.id)?.thinking).toBe("high");

    const clear = await jobPUT(
      editorReq(org.id, `http://x/api/jobs/${job.id}`, "PUT", { thinking: "" }),
      ctx({ id: job.id }),
    );
    expect(clear.status).toBe(200);
    expect(getJobById(job.id)?.thinking).toBeNull();
  });

  it("rejects a thinking override on a workflow job (no agent, no CLI)", async () => {
    const { org, project } = fixture();
    const job = createWorkflow(org.id, project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const res = await jobPUT(
      editorReq(org.id, `http://x/api/jobs/${job.id}`, "PUT", { thinking: "high" }),
      ctx({ id: job.id }),
    );
    expect(res.status).toBe(400);
  });
});
