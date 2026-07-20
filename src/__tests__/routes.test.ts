import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { POST as agentTablesPOST } from "@/app/api/agents/[id]/tables/route";
import { GET as agentsGET } from "@/app/api/agents/route";
import { POST as docsPOST } from "@/app/api/docs/route";
import { POST as jobDocsPOST } from "@/app/api/jobs/[id]/docs/route";
import { POST as jobEnvVarsPOST } from "@/app/api/jobs/[id]/env-vars/route";
import { POST as jobTablesPOST } from "@/app/api/jobs/[id]/tables/route";
import { POST as jobTriggerPOST } from "@/app/api/jobs/[id]/trigger/route";
import { POST as jobsPOST } from "@/app/api/jobs/route";
import { POST as claimPOST } from "@/app/api/runner/claim/route";
import { POST as activityPOST } from "@/app/api/runs/[id]/activity/route";
import { GET as processingGET } from "@/app/api/runs/[id]/attachments/[aid]/processing/route";
import { GET as screenshotFileGET } from "@/app/api/runs/[id]/attachments/[aid]/screenshots/[index]/file/route";
import { GET as screenshotsGET } from "@/app/api/runs/[id]/attachments/[aid]/screenshots/route";
import { GET as transcriptGET } from "@/app/api/runs/[id]/attachments/[aid]/transcript/route";
import { DELETE as runDELETE, GET as runGET } from "@/app/api/runs/[id]/route";
import { GET as runStatusGET, PUT as runStatusPUT } from "@/app/api/runs/[id]/status/route";
import { GET as runsHistoryGET } from "@/app/api/runs/history/route";
import { GET as runsGET } from "@/app/api/runs/route";
import {
  createAgent,
  createDoc,
  createEnvVar,
  createFileAttachment,
  createJob,
  createProcessingRecord,
  createProject,
  createRun,
  createRunner,
  createSession,
  createTable,
  createUser,
  createWorkflow,
  mintExecToken,
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

type ReqInit = { method?: string; body?: string; headers?: HeadersInit };

function userReq(userId: string, url: string, init: ReqInit = {}): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers(init.headers);
  headers.set("cookie", `harbour_session=${sessionId}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

/** A request carrying any bearer token (runner token or run exec token). */
function bearerReq(token: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

/** Mint a run's exec token (the credential the runner/CLI use for its lifecycle). */
function execToken(runId: string): string {
  return mintExecToken(runId);
}

/** A JSON body wrapping advertised runner capabilities for a claim POST. */
function claimBody(caps?: Partial<{ kinds: string[]; clis: string[]; labels: string[] }>): string {
  return JSON.stringify({
    capabilities: {
      kinds: caps?.kinds ?? ["agent", "workflow"],
      clis: caps?.clis ?? ["claude", "codex", "gemini"],
      labels: caps?.labels ?? ["local"],
    },
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function fixture() {
  const project = createProject("Site")!;
  const user = createUser("u@x.com", "pw", "User")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  return { project, user, agent, job, run };
}

// A second, fully independent project — resources are visible and linkable
// across projects (project is an organizational boundary, not a security one).
function otherProjectFixture() {
  const project = createProject("OtherSite")!;
  const agent = createAgent(project.id, "OtherDev");
  const job = createJob(project.id, agent.id, { name: "OtherJob", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!; // status 'running'
  const doc = createDoc(project.id, "OtherDoc")!;
  const envVar = createEnvVar(project.id, "OTHER_SECRET", "val")!;
  const table = createTable(project.id, "other_db", [{ name: "c", type: "TEXT" }]);
  return { project, agent, job, run, doc, envVar, table };
}

describe("GET /api/agents", () => {
  it("?projectId= narrows to that project; the payload carries project_name", async () => {
    const { project, user } = fixture();
    otherProjectFixture();
    const res = await agentsGET(
      userReq(user.id, `http://x/api/agents?projectId=${project.id}`),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].project_name).toBe("Site");
  });

  it("omitted projectId is the union across all projects", async () => {
    const { user } = fixture();
    otherProjectFixture();
    const res = await agentsGET(userReq(user.id, "http://x/api/agents"), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(2);
  });
});

describe("GET/DELETE /api/runs/[id]", () => {
  it("a user reads and deletes a run", async () => {
    const { run, user } = fixture();
    expect((await runGET(userReq(user.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await runDELETE(userReq(user.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
  });

  it("404 for a missing run", async () => {
    const { user } = fixture();
    expect((await runGET(userReq(user.id, "http://x/"), ctx({ id: "ghost" }))).status).toBe(404);
    expect((await runDELETE(userReq(user.id, "http://x/"), ctx({ id: "ghost" }))).status).toBe(404);
  });
});

describe("POST /api/docs (agent or user)", () => {
  it("a user creates a doc in a project", async () => {
    const { project, user } = fixture();
    const req = userReq(user.id, `http://x/api/docs?projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({ title: "Brand" }),
      headers: JSON_HEADERS,
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    expect((await res.json()).project_id).toBe(project.id);
  });

  it("400 when no project is resolvable", async () => {
    const { user } = fixture();
    const req = userReq(user.id, "http://x/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "Homeless" }),
      headers: JSON_HEADERS,
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("projectId is required");
  });

  it("404 for an unknown projectId", async () => {
    const { user } = fixture();
    const req = userReq(user.id, "http://x/api/docs?projectId=ghost", {
      method: "POST",
      body: JSON.stringify({ title: "Lost" }),
      headers: JSON_HEADERS,
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Project not found");
  });

  it("an agent (via its run's exec token) defaults to its own project", async () => {
    const { agent, run } = fixture();
    const req = bearerReq(execToken(run.id), "http://x/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "Agent Doc" }),
      headers: JSON_HEADERS,
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc.project_id).toBe(agent.project_id);
  });

  it("an explicit projectId overrides the agent's home project", async () => {
    const { run } = fixture();
    const other = otherProjectFixture();
    const req = bearerReq(execToken(run.id), "http://x/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "Elsewhere", projectId: other.project.id }),
      headers: JSON_HEADERS,
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    expect((await res.json()).project_id).toBe(other.project.id);
  });
});

describe("job<->resource links are unrestricted across projects", () => {
  it("links another project's doc to a job (idempotently)", async () => {
    const { job, user } = fixture();
    const other = otherProjectFixture();
    const req = () =>
      userReq(user.id, "http://x/", {
        method: "POST",
        body: JSON.stringify({ docId: other.doc.id }),
        headers: JSON_HEADERS,
      });
    const res = await jobDocsPOST(req(), ctx({ id: job.id }));
    expect(res.status).toBe(201);
    // INSERT OR IGNORE: re-linking is a no-op, not an error or a duplicate row.
    await jobDocsPOST(req(), ctx({ id: job.id }));
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_docs WHERE job_id = ? AND doc_id = ?`)
      .get(job.id, other.doc.id) as { n: number };
    expect(linked.n).toBe(1);
  });

  it("links another project's env var to a job", async () => {
    const { job, user } = fixture();
    const other = otherProjectFixture();
    const req = userReq(user.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ envVarId: other.envVar.id }),
      headers: JSON_HEADERS,
    });
    const res = await jobEnvVarsPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(201);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_env_vars WHERE job_id = ? AND env_var_id = ?`)
      .get(job.id, other.envVar.id) as { n: number };
    expect(linked.n).toBe(1);
  });

  it("links another project's table to a job", async () => {
    const { job, user } = fixture();
    const other = otherProjectFixture();
    const req = userReq(user.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ tableId: other.table.id }),
      headers: JSON_HEADERS,
    });
    const res = await jobTablesPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(201);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_tables WHERE job_id = ? AND table_id = ?`)
      .get(job.id, other.table.id) as { n: number };
    expect(linked.n).toBe(1);
  });

  it("404 for a nonexistent linked resource", async () => {
    const { job, user } = fixture();
    const req = userReq(user.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ docId: "ghost" }),
      headers: JSON_HEADERS,
    });
    const res = await jobDocsPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Doc not found");
  });
});

describe("run lists: optional projectId filter", () => {
  it("GET /api/runs?projectId= narrows to one project; omitted spans all", async () => {
    const { project, user } = fixture(); // one 'running' run
    const other = otherProjectFixture(); // another 'running' run elsewhere

    const scopedRes = await runsGET(
      userReq(user.id, `http://x/api/runs?projectId=${project.id}`),
      ctx({}),
    );
    expect(scopedRes.status).toBe(200);
    const scopedBody = await scopedRes.json();
    const scopedIds = [
      ...scopedBody.scheduled,
      ...scopedBody.running,
      ...scopedBody.waiting,
      ...scopedBody.recent,
    ].map((r: { id: string }) => r.id);
    expect(scopedIds).not.toContain(other.run.id);
    expect(scopedBody.running.length).toBe(1);

    const allRes = await runsGET(userReq(user.id, "http://x/api/runs"), ctx({}));
    const allBody = await allRes.json();
    expect(allBody.running.map((r: { id: string }) => r.id)).toContain(other.run.id);
  });

  it("GET /api/runs/history honors the projectId filter", async () => {
    const { project, user, run } = fixture();
    const other = otherProjectFixture();

    const res = await runsHistoryGET(
      userReq(
        user.id,
        `http://x/api/runs/history?projectId=${project.id}&status=running&includeSkipped=1`,
      ),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const ids = (await res.json()).runs.map((r: { id: string }) => r.id);
    expect(ids).toContain(run.id);
    expect(ids).not.toContain(other.run.id);
  });
});

describe("POST /api/runs/[id]/activity", () => {
  it("a user can post a comment", async () => {
    const { run, user } = fixture();
    const req = userReq(user.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "looks good" }),
      headers: JSON_HEADERS,
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(201);
  });

  it("the run's executor can post activity", async () => {
    const { run } = fixture();
    const req = bearerReq(execToken(run.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "working" }),
      headers: JSON_HEADERS,
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(201);
  });

  it("an exec token cannot post to a different run's thread (403)", async () => {
    const { project, run } = fixture();
    const otherJob = createJob(project.id, createAgent(project.id, "DevB").id, {
      name: "K",
      schedule: '{"every":60}',
    })!;
    const otherRun = createRun(otherJob.id, null)!;
    const req = bearerReq(execToken(otherRun.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "intruder" }),
      headers: JSON_HEADERS,
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });
});

describe("job creation: workflows vs agent prerun gates", () => {
  it("POST /api/jobs creates a first-class workflow job", async () => {
    const { project, user } = fixture();
    const req = userReq(user.id, `http://x/api/jobs?projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({
        name: "X",
        schedule: '{"every":60}',
        command: { runtime: "bash", content: "echo hi" },
      }),
      headers: JSON_HEADERS,
    });
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe("workflow");
    expect(body.workflow_script).toBe("echo hi");
  });

  it("POST /api/jobs requires a resolvable project (400) and rejects an unknown one (404)", async () => {
    const { user } = fixture();
    const body = JSON.stringify({
      name: "X",
      schedule: '{"every":60}',
      command: { runtime: "bash", content: "echo hi" },
    });
    const missing = await jobsPOST(
      userReq(user.id, "http://x/api/jobs", { method: "POST", body, headers: JSON_HEADERS }),
      ctx({}),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("projectId is required");

    const unknown = await jobsPOST(
      userReq(user.id, "http://x/api/jobs?projectId=ghost", {
        method: "POST",
        body,
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("Project not found");
  });

  it("POST /api/jobs rejects an agentId (agent jobs use the agent endpoint)", async () => {
    const { project, user, agent } = fixture();
    const req = userReq(user.id, `http://x/api/jobs?projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({
        name: "X",
        schedule: '{"every":60}',
        command: { runtime: "bash", content: "echo hi" },
        agentId: agent.id,
      }),
      headers: JSON_HEADERS,
    });
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("POST /api/agents/:id/jobs creates an agent job with a prerun gate", async () => {
    const { user, agent } = fixture();
    const req = userReq(user.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({
        name: "Combined",
        schedule: '{"every":60}',
        prerun: { runtime: "bash", content: "exit 77" },
      }),
      headers: JSON_HEADERS,
    });
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.agent_id).toBe(agent.id);
    expect(job.kind).toBe("agent");
    expect(job.prerun_script).toBe("exit 77");
  });
});

describe("workflow run reporting (exec token)", () => {
  // Workflow runs have agent_id = null. The run's executor (its exec token)
  // reports status even though no agent owns the run.
  it("the run's executor can set status on a workflow run", async () => {
    const { project } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const run = createRun(wfJob.id, null)!;
    const putReq = bearerReq(execToken(run.id), "http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: JSON_HEADERS,
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(200);
  });

  it("an exec token for one run cannot set status on another run", async () => {
    const { project, run } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const otherRun = createRun(wfJob.id, null)!;
    const putReq = bearerReq(execToken(otherRun.id), "http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: JSON_HEADERS,
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });
});

describe("agent self-ownership", () => {
  it("an agent cannot trigger another agent's job", async () => {
    const { project, job } = fixture(); // job belongs to agent A
    const agentB = createAgent(project.id, "DevB"); // same project, different agent
    const jobB = createJob(project.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;
    const runB = createRun(jobB.id, agentB.id)!;
    // agentB acts via its own run's exec token — it must not reach agent A's job.
    const req = bearerReq(execToken(runB.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: JSON_HEADERS,
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(404);
  });

  it("an agent can trigger its own job", async () => {
    const { job, run } = fixture(); // run belongs to the same agent as job
    const req = bearerReq(execToken(run.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: JSON_HEADERS,
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(201);
  });

  // Regression: the runner reads GET /api/runs/:id/status after a CLI exits to
  // see whether the agent set a final status. The full run detail (GET
  // /api/runs/:id) is user-only, so without this executor-readable endpoint
  // the runner always read "running" and wrongly force-failed every run.
  it("the run's executor can read its own status", async () => {
    const { run } = fixture();
    const req = bearerReq(execToken(run.id), "http://x/");
    const res = await runStatusGET(req, ctx({ id: run.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("running");
  });

  it("an exec token cannot read another run's status", async () => {
    const { project, run } = fixture();
    const otherRun = createRun(
      createJob(project.id, createAgent(project.id, "DevB").id, {
        name: "K",
        schedule: '{"every":60}',
      })!.id,
      null,
    )!;
    const req = bearerReq(execToken(otherRun.id), "http://x/");
    const res = await runStatusGET(req, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });

  it("an agent cannot write table data as another agent", async () => {
    const { project, agent } = fixture(); // agent A
    const agentB = createAgent(project.id, "DevB"); // same project, different agent
    const jobB = createJob(project.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;
    const runB = createRun(jobB.id, agentB.id)!;
    // agentB's exec token acts as agentB — it must not write to agent A's tables.
    const req = bearerReq(execToken(runB.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({ name: "tbl", columns: [{ name: "c", type: "TEXT" }] }),
      headers: JSON_HEADERS,
    });
    const res = await agentTablesPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/runner/claim", () => {
  it("a local runner claims a due agent run and gets an exec token", async () => {
    const { project } = fixture();
    const agent = createAgent(project.id, "ClaudeDev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "Daily", schedule: '{"every":60}' })!;
    getDb().prepare(`UPDATE jobs SET next_run_at = 1 WHERE id = ?`).run(job.id);

    const runner = createRunner({ name: "Local", tier: "local" });
    const res = await claimPOST(
      bearerReq(runner.token, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody(),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.kind).toBe("agent");
    expect(body.run.status).toBe("running");
    expect(body.exec_token).toMatch(/^hbx_/);
    // The exec token is the only credential surfaced — never the runner token.
    expect(JSON.stringify(body)).not.toContain(runner.token);
  });

  it("returns { run: null } when nothing is due", async () => {
    fixture();
    const runner = createRunner({ name: "Local", tier: "local" });
    const res = await claimPOST(
      bearerReq(runner.token, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody(),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).run).toBeNull();
  });

  it("an agent-scoped remote runner claims only its agent's work, never workflows", async () => {
    const { project } = fixture();
    const db = getDb();

    // A due agent job and a due workflow job.
    const agent = createAgent(project.id, "ClaudeDev", undefined, { cli: "claude" });
    const agentJob = createJob(project.id, agent.id, { name: "Daily", schedule: '{"every":60}' })!;
    const wfJob = createWorkflow(project.id, {
      name: "wf",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    db.prepare(`UPDATE jobs SET next_run_at = 1 WHERE id IN (?, ?)`).run(agentJob.id, wfJob.id);

    // A runner scoped to a DIFFERENT agent sees neither.
    const otherAgent = createAgent(project.id, "OtherDev", undefined, { cli: "claude" });
    const scopedAway = createRunner({
      name: "Away",
      tier: "remote",
      labels: ["local"],
      scope: { agentId: otherAgent.id },
    });
    const awayRes = await claimPOST(
      bearerReq(scopedAway.token, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody(),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(awayRes.status).toBe(200);
    expect((await awayRes.json()).run).toBeNull();

    // A runner scoped to the agent claims the agent job — not the workflow
    // (an agent-scoped token never runs workflows).
    const scoped = createRunner({
      name: "Agent-only",
      tier: "remote",
      labels: ["local"],
      scope: { agentId: agent.id },
    });
    const res = await claimPOST(
      bearerReq(scoped.token, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody(),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe(agentJob.id);
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM runs WHERE job_id = ?`).get(wfJob.id) as { n: number }).n,
    ).toBe(0);
  });

  it("rejects a non-runner caller (run exec token / user) with 403", async () => {
    const { run, user } = fixture();
    const execRes = await claimPOST(
      bearerReq(execToken(run.id), "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody({ kinds: ["workflow"], clis: [] }),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(execRes.status).toBe(403);
    const userRes = await claimPOST(
      userReq(user.id, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody({ kinds: ["workflow"], clis: [] }),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(userRes.status).toBe(403);
  });

  it("rejects a missing/invalid capabilities body with 400", async () => {
    const runner = createRunner({ name: "Local", tier: "local" });
    const res = await claimPOST(
      bearerReq(runner.token, "http://x/api/runner/claim", {
        method: "POST",
        body: JSON.stringify({}),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });
});

describe("attachment processing sub-routes are confined to the run in the URL", () => {
  // An exec token is pinned to its own run id, so the only way to exfiltrate
  // another run's video artifacts would be passing a foreign attachment id
  // under your own run id. Every processing sub-route must 404 on that.
  function foreignAttachmentFixture() {
    const { project, run } = fixture(); // run A — the caller's own run
    const agentB = createAgent(project.id, "DevB");
    const jobB = createJob(project.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;
    const runB = createRun(jobB.id, agentB.id)!;
    const att = createFileAttachment({
      runId: runB.id,
      filename: "demo.mp4",
      storagePath: `${runB.id}/demo.mp4`,
      mimeType: "video/mp4",
      sizeBytes: 10,
      uploader: { type: "agent", id: agentB.id, name: "DevB" },
    });
    createProcessingRecord(att.id, runB.id, 5);
    return { run, runB, att };
  }

  it("processing GET 404s for a foreign attachment id, 200s for the owning run", async () => {
    const { run, runB, att } = foreignAttachmentFixture();
    const foreign = await processingGET(
      bearerReq(execToken(run.id), "http://x/"),
      ctx({ id: run.id, aid: att.id }),
    );
    expect(foreign.status).toBe(404);
    const own = await processingGET(
      bearerReq(execToken(runB.id), "http://x/"),
      ctx({ id: runB.id, aid: att.id }),
    );
    expect(own.status).toBe(200);
    expect((await own.json()).run_id).toBe(runB.id);
  });

  it("transcript, screenshots list, and screenshot file GET all 404 on a foreign attachment id", async () => {
    const { run, att } = foreignAttachmentFixture();
    // Give the processing row artifacts so only the run check can 404.
    getDb()
      .prepare(
        `UPDATE attachment_processing SET transcript_path = 't.txt', screenshots_dir = 's' WHERE attachment_id = ?`,
      )
      .run(att.id);
    const token = execToken(run.id);
    const transcript = await transcriptGET(
      bearerReq(token, "http://x/"),
      ctx({ id: run.id, aid: att.id }),
    );
    expect(transcript.status).toBe(404);
    const list = await screenshotsGET(
      bearerReq(token, "http://x/"),
      ctx({ id: run.id, aid: att.id }),
    );
    expect(list.status).toBe(404);
    const file = await screenshotFileGET(
      bearerReq(token, "http://x/"),
      ctx({ id: run.id, aid: att.id, index: "0" }),
    );
    expect(file.status).toBe(404);
  });
});
