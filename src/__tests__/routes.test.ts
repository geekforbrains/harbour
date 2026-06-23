import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { POST as agentTablesPOST } from "@/app/api/agents/[id]/tables/route";
import { GET as agentsGET } from "@/app/api/agents/route";
import { POST as docsPOST } from "@/app/api/docs/route";
import { POST as envVarsPOST } from "@/app/api/env-vars/route";
import { POST as jobDocsPOST } from "@/app/api/jobs/[id]/docs/route";
import { POST as jobEnvVarsPOST } from "@/app/api/jobs/[id]/env-vars/route";
import { POST as jobTablesPOST } from "@/app/api/jobs/[id]/tables/route";
import { POST as jobTriggerPOST } from "@/app/api/jobs/[id]/trigger/route";
import { POST as jobsPOST } from "@/app/api/jobs/route";
import { PUT as orgsPUT } from "@/app/api/orgs/route";
import { POST as claimPOST } from "@/app/api/runner/claim/route";
import { DELETE as runnerDELETE } from "@/app/api/runners/[id]/route";
import { GET as runnersGET, POST as runnersPOST } from "@/app/api/runners/route";
import { POST as activityPOST } from "@/app/api/runs/[id]/activity/route";
import { DELETE as runDELETE, GET as runGET } from "@/app/api/runs/[id]/route";
import { GET as runStatusGET, PUT as runStatusPUT } from "@/app/api/runs/[id]/status/route";
import { GET as runsHistoryGET } from "@/app/api/runs/history/route";
import { GET as runsGET } from "@/app/api/runs/route";
import {
  addMembership,
  createAgent,
  createDoc,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  createRun,
  createRunner,
  createSession,
  createTable,
  createUser,
  createWorkflow,
  getOrgSettings,
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
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const editor = createUser("e@x.com", "pw", "Editor")!;
  const viewer = createUser("v@x.com", "pw", "Viewer")!;
  const outsider = createUser("o@x.com", "pw", "Outsider")!;
  addMembership(editor.id, org.id, "editor");
  addMembership(viewer.id, org.id, "viewer");
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!;
  return { org, project, editor, viewer, outsider, agent, job, run };
}

describe("GET /api/agents (project-scoped list)", () => {
  it("viewer can list agents in their project", async () => {
    const { project, viewer } = fixture();
    const res = await agentsGET(
      userReq(viewer.id, `http://x/api/agents?projectId=${project.id}`),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  it("outsider is forbidden", async () => {
    const { project, outsider } = fixture();
    const res = await agentsGET(
      userReq(outsider.id, `http://x/api/agents?projectId=${project.id}`),
      ctx({}),
    );
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/orgs (org settings, backs useUpdateOrg)", () => {
  it("editor updates the org timezone (settings merge)", async () => {
    const { org, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/orgs?orgId=${org.id}`, {
      method: "PUT",
      body: JSON.stringify({ settings: { timezone: "America/New_York" } }),
      headers: { "content-type": "application/json" },
    });
    const res = await orgsPUT(req, ctx({}));
    expect(res.status).toBe(200);
    expect(getOrgSettings(org.id).timezone).toBe("America/New_York");
  });

  it("merge preserves unrelated settings keys", async () => {
    const { org, editor } = fixture();
    const first = userReq(editor.id, `http://x/api/orgs?orgId=${org.id}`, {
      method: "PUT",
      body: JSON.stringify({ settings: { foo: "bar" } }),
      headers: { "content-type": "application/json" },
    });
    await orgsPUT(first, ctx({}));
    const second = userReq(editor.id, `http://x/api/orgs?orgId=${org.id}`, {
      method: "PUT",
      body: JSON.stringify({ settings: { timezone: "UTC" } }),
      headers: { "content-type": "application/json" },
    });
    await orgsPUT(second, ctx({}));
    const settings = getOrgSettings(org.id);
    expect(settings.timezone).toBe("UTC");
    expect(settings.foo).toBe("bar");
  });

  it("viewer cannot update the org", async () => {
    const { org, viewer } = fixture();
    const req = userReq(viewer.id, `http://x/api/orgs?orgId=${org.id}`, {
      method: "PUT",
      body: JSON.stringify({ settings: { timezone: "UTC" } }),
      headers: { "content-type": "application/json" },
    });
    const res = await orgsPUT(req, ctx({}));
    expect(res.status).toBe(403);
  });
});

describe("GET/DELETE /api/runs/[id]", () => {
  it("viewer reads, editor deletes, viewer cannot delete", async () => {
    const { run, viewer, editor } = fixture();
    expect((await runGET(userReq(viewer.id, "http://x/"), ctx({ id: run.id }))).status).toBe(200);
    expect((await runDELETE(userReq(viewer.id, "http://x/"), ctx({ id: run.id }))).status).toBe(
      403,
    );
    expect((await runDELETE(userReq(editor.id, "http://x/"), ctx({ id: run.id }))).status).toBe(
      200,
    );
  });
});

describe("POST /api/docs (agent or editor)", () => {
  it("editor creates an org-level doc", async () => {
    const { org, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/docs?orgId=${org.id}`, {
      method: "POST",
      body: JSON.stringify({ title: "Brand" }),
      headers: { "content-type": "application/json" },
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(201);
  });

  it("viewer cannot create a doc", async () => {
    const { org, viewer } = fixture();
    const req = userReq(viewer.id, `http://x/api/docs?orgId=${org.id}`, {
      method: "POST",
      body: JSON.stringify({ title: "Brand" }),
      headers: { "content-type": "application/json" },
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(403);
  });

  it("an agent (via its run's exec token) creates a doc scoped to its project", async () => {
    const { agent, run } = fixture();
    const req = bearerReq(execToken(run.id), "http://x/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "Agent Doc" }),
      headers: { "content-type": "application/json" },
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc.project_id).toBe(agent.project_id);
  });
});

// A second, fully independent org used to assert cross-org isolation.
function otherOrgFixture() {
  const org = createOrg("Globex")!;
  const project = createProject(org.id, "OtherSite")!;
  const agent = createAgent(project.id, "OtherDev");
  const job = createJob(project.id, agent.id, { name: "OtherJob", schedule: '{"every":60}' })!;
  const run = createRun(job.id, agent.id)!; // status 'running'
  const doc = createDoc(org.id, project.id, "OtherDoc")!;
  const envVar = createEnvVar(org.id, project.id, "OTHER_SECRET", "val")!;
  const table = createTable(org.id, project.id, "other_db", [{ name: "c", type: "TEXT" }]);
  return { org, project, agent, job, run, doc, envVar, table };
}

describe("cross-org isolation (negative tests)", () => {
  it("GET /api/runs does not leak another org's runs", async () => {
    const { org: orgA, editor } = fixture();
    const other = otherOrgFixture(); // org-B has a running run

    const res = await runsGET(userReq(editor.id, `http://x/api/runs?orgId=${orgA.id}`), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    const allIds = [...body.scheduled, ...body.running, ...body.waiting, ...body.recent].map(
      (r) => r.id,
    );
    expect(allIds).not.toContain(other.run.id);
    // sanity: org-A's own running run IS visible
    // (fixture creates a 'running' run for org-A)
    expect(body.running.length).toBe(1);
  });

  it("GET /api/runs/history does not leak another org's runs", async () => {
    const { org: orgA, editor } = fixture();
    const other = otherOrgFixture();

    // include every status so the only thing keeping org-B out is org scoping
    const res = await runsHistoryGET(
      userReq(
        editor.id,
        `http://x/api/runs/history?orgId=${orgA.id}&status=running&includeSkipped=1`,
      ),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.runs.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(other.run.id);
  });

  it("POST /api/runner/claim: an org-scoped remote runner ignores other orgs' work", async () => {
    fixture(); // org A (no due work)
    const other = otherOrgFixture(); // org B

    // org B has a ready workflow job, due in the past.
    const db = getDb();
    const wfJobId = createWorkflow(other.org.id, other.project.id, {
      name: "wf",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!.id;
    db.prepare(`UPDATE jobs SET next_run_at = 1 WHERE id = ?`).run(wfJobId);

    // A remote runner scoped to org B's sibling (a different org) must not see it.
    const elsewhere = createOrg("Elsewhere")!;
    const scopedAway = createRunner({
      name: "Away",
      tier: "remote",
      labels: ["local"],
      scope: { orgId: elsewhere.id },
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
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM runs WHERE job_id = ?`).get(wfJobId) as { n: number }).n,
    ).toBe(0);

    // A remote runner scoped to org B claims it.
    const scopedB = createRunner({
      name: "B-only",
      tier: "remote",
      labels: ["local"],
      scope: { orgId: other.org.id },
    });
    const res = await claimPOST(
      bearerReq(scopedB.token, "http://x/api/runner/claim", {
        method: "POST",
        body: claimBody(),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.kind).toBe("workflow");
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM runs WHERE job_id = ?`).get(wfJobId) as { n: number }).n,
    ).toBe(1);
  });

  it("rejects linking an org-B doc to an org-A job", async () => {
    const { job: jobA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ docId: other.doc.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobDocsPOST(req, ctx({ id: jobA.id }));
    expect(res.status).toBe(404);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_docs WHERE job_id = ? AND doc_id = ?`)
      .get(jobA.id, other.doc.id) as { n: number };
    expect(linked.n).toBe(0);
  });

  it("rejects linking an org-B env var to an org-A job", async () => {
    const { job: jobA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ envVarId: other.envVar.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobEnvVarsPOST(req, ctx({ id: jobA.id }));
    expect(res.status).toBe(404);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_env_vars WHERE job_id = ? AND env_var_id = ?`)
      .get(jobA.id, other.envVar.id) as { n: number };
    expect(linked.n).toBe(0);
  });

  it("rejects linking an org-B table to an org-A job", async () => {
    const { job: jobA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ tableId: other.table.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTablesPOST(req, ctx({ id: jobA.id }));
    expect(res.status).toBe(404);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_tables WHERE job_id = ? AND table_id = ?`)
      .get(jobA.id, other.table.id) as { n: number };
    expect(linked.n).toBe(0);
  });

  it("rejects creating a doc with an org-B projectId", async () => {
    const { org: orgA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, `http://x/api/docs?orgId=${orgA.id}`, {
      method: "POST",
      body: JSON.stringify({ title: "Leaky", projectId: other.project.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await docsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("rejects creating an env var with an org-B projectId", async () => {
    const { org: orgA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, `http://x/api/env-vars?orgId=${orgA.id}`, {
      method: "POST",
      body: JSON.stringify({ name: "LEAK", value: "v", projectId: other.project.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await envVarsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/runs/[id]/activity (viewer may comment)", () => {
  it("viewer can post a comment", async () => {
    const { run, viewer } = fixture();
    const req = userReq(viewer.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "looks good" }),
      headers: { "content-type": "application/json" },
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

  it("an outsider cannot comment", async () => {
    const { run, outsider } = fixture();
    const req = userReq(outsider.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "nope" }),
      headers: { "content-type": "application/json" },
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });
});

describe("job creation: workflows vs agent prerun gates", () => {
  it("POST /api/jobs creates a first-class workflow job", async () => {
    const { org, project, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/jobs?orgId=${org.id}&projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({
        name: "X",
        schedule: '{"every":60}',
        command: { runtime: "bash", content: "echo hi" },
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe("workflow");
    expect(body.workflow_script).toBe("echo hi");
  });

  it("POST /api/jobs rejects an agentId (agent jobs use the agent endpoint)", async () => {
    const { org, project, editor, agent } = fixture();
    const req = userReq(editor.id, `http://x/api/jobs?orgId=${org.id}&projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({
        name: "X",
        schedule: '{"every":60}',
        command: { runtime: "bash", content: "echo hi" },
        agentId: agent.id,
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("POST /api/agents/:id/jobs creates an agent job with a prerun gate", async () => {
    const { editor, agent } = fixture();
    const req = userReq(editor.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({
        name: "Combined",
        schedule: '{"every":60}',
        prerun: { runtime: "bash", content: "exit 77" },
      }),
      headers: { "content-type": "application/json" },
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
    const wfJob = createWorkflow(project.org_id, project.id, {
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
    const wfJob = createWorkflow(project.org_id, project.id, {
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

describe("agent self-ownership (within an org)", () => {
  it("an agent cannot trigger another agent's job in the same org", async () => {
    const { project, job } = fixture(); // job belongs to agent A
    const agentB = createAgent(project.id, "DevB"); // same project/org, different agent
    const jobB = createJob(project.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;
    const runB = createRun(jobB.id, agentB.id)!;
    // agentB acts via its own run's exec token — it must not reach agent A's job.
    const req = bearerReq(execToken(runB.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(404);
  });

  it("an agent can trigger its own job", async () => {
    const { job, run } = fixture(); // run belongs to the same agent as job
    const req = bearerReq(execToken(run.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(201);
  });

  // Regression: the runner reads GET /api/runs/:id/status after a CLI exits to
  // see whether the agent set a final status. The full run detail (GET
  // /api/runs/:id) is user/admin-only, so without this executor-readable
  // endpoint the runner always read "running" and wrongly force-failed every run.
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

  it("an agent cannot write table data as another agent in the same org", async () => {
    const { project, agent } = fixture(); // agent A
    const agentB = createAgent(project.id, "DevB"); // same org, different agent
    const jobB = createJob(project.id, agentB.id, { name: "JB", schedule: '{"every":60}' })!;
    const runB = createRun(jobB.id, agentB.id)!;
    // agentB's exec token acts as agentB — it must not write to agent A's tables.
    const req = bearerReq(execToken(runB.id), "http://x/", {
      method: "POST",
      body: JSON.stringify({ name: "tbl", columns: [{ name: "c", type: "TEXT" }] }),
      headers: { "content-type": "application/json" },
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

  it("rejects a non-runner caller (run exec token / user) with 403", async () => {
    const { run, editor } = fixture();
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
      userReq(editor.id, "http://x/api/runner/claim", {
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

describe("/api/runners (mint remote runner credentials — instance admin)", () => {
  it("an admin mints a labeled/scoped remote runner; the connect blob decodes to {url,token,name}", async () => {
    const { org } = fixture();
    const admin = createUser("admin@x.com", "pw", "Admin", { isInstanceAdmin: true })!;
    const res = await runnersPOST(
      userReq(admin.id, "http://x/api/runners", {
        method: "POST",
        body: JSON.stringify({ name: "GPU box", labels: ["gpu"], scope: { orgId: org.id } }),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tier).toBe("remote");
    expect(body.labels).toEqual(["gpu"]);
    expect(body.token).toMatch(/^hbrn_/);
    expect(body.connect).toMatch(/^npm run harbour-agent -- connect /);
    const blob = body.connect.replace("npm run harbour-agent -- connect ", "");
    const decoded = JSON.parse(Buffer.from(blob, "base64").toString("utf-8"));
    expect(decoded).toMatchObject({ token: body.token, name: "GPU box" });
    expect(typeof decoded.url).toBe("string");
  });

  it("lists runners (no token leaks) and revokes one; non-admins are forbidden", async () => {
    const { editor } = fixture();
    const admin = createUser("admin@x.com", "pw", "Admin", { isInstanceAdmin: true })!;
    const minted = createRunner({ name: "Box", tier: "remote", labels: ["gpu"] });

    // A non-admin (org editor) cannot mint, list, or revoke.
    const editorMint = await runnersPOST(
      userReq(editor.id, "http://x/api/runners", {
        method: "POST",
        body: JSON.stringify({ name: "X" }),
        headers: JSON_HEADERS,
      }),
      ctx({}),
    );
    expect(editorMint.status).toBe(403);

    const listRes = await runnersGET(userReq(admin.id, "http://x/api/runners"), ctx({}));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((r: { id: string }) => r.id === minted.id)).toBe(true);
    for (const r of list) expect(r.token).toBeUndefined();

    const del = await runnerDELETE(
      userReq(admin.id, "http://x/", { method: "DELETE" }),
      ctx({ id: minted.id }),
    );
    expect(del.status).toBe(200);
    const after = await (
      await runnersGET(userReq(admin.id, "http://x/api/runners"), ctx({}))
    ).json();
    expect(after.some((r: { id: string }) => r.id === minted.id)).toBe(false);
  });
});
