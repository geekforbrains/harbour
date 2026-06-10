import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as agentDataPOST } from "@/app/api/agents/[id]/data/route";
import { POST as agentJobsPOST } from "@/app/api/agents/[id]/jobs/route";
import { GET as agentsGET } from "@/app/api/agents/route";
import { POST as docsPOST } from "@/app/api/docs/route";
import { POST as envVarsPOST } from "@/app/api/env-vars/route";
import { POST as jobDataPOST } from "@/app/api/jobs/[id]/data/route";
import { POST as jobDocsPOST } from "@/app/api/jobs/[id]/docs/route";
import { POST as jobEnvVarsPOST } from "@/app/api/jobs/[id]/env-vars/route";
import { POST as jobTriggerPOST } from "@/app/api/jobs/[id]/trigger/route";
import { POST as jobsPOST } from "@/app/api/jobs/route";
import { PUT as orgsPUT } from "@/app/api/orgs/route";
import { POST as activityPOST } from "@/app/api/runs/[id]/activity/route";
import { DELETE as runDELETE, GET as runGET } from "@/app/api/runs/[id]/route";
import { GET as runStatusGET, PUT as runStatusPUT } from "@/app/api/runs/[id]/status/route";
import { GET as runsHistoryGET } from "@/app/api/runs/history/route";
import { GET as runsGET } from "@/app/api/runs/route";
import { POST as workflowRunnersPOST } from "@/app/api/workflow-runners/route";
import { GET as workflowsNextGET } from "@/app/api/workflows/next/route";
import {
  addMembership,
  createAgent,
  createDatabase,
  createDoc,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  createRun,
  createSession,
  createUser,
  createWorkflow,
  createWorkflowRunner,
  getOrgSettings,
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

function agentReq(apiKey: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function workflowRunnerReq(apiKey: string, url: string, init: ReqInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

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

  it("an agent creates a doc scoped to its project", async () => {
    const { agent } = fixture();
    const req = agentReq(agent.apiKey, "http://x/api/docs", {
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
  const database = createDatabase(org.id, project.id, "other_db", [{ name: "c", type: "TEXT" }]);
  return { org, project, agent, job, run, doc, envVar, database };
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

  it("GET /api/workflows/next requires workflow-runner auth and respects org scope", async () => {
    const { agent: agentA } = fixture(); // org-A agent
    const other = otherOrgFixture();

    // Make org-B a ready workflow job, due in the past.
    const db = getDb();
    const wfJobId = createWorkflow(other.project.id, {
      name: "wf",
      schedule: '{"every":60}',
      command: "echo hi",
    })!.id;
    db.prepare(`UPDATE jobs SET next_run_at = 1 WHERE id = ?`).run(wfJobId);

    const agentRes = await workflowsNextGET(
      agentReq(agentA.apiKey, "http://x/api/workflows/next"),
      ctx({}),
    );
    expect(agentRes.status).toBe(403);

    const runnerA = createWorkflowRunner(other.org.id, "Server")!;
    const peekRes = await workflowsNextGET(
      workflowRunnerReq(runnerA.apiKey, "http://x/api/workflows/next?peek=true"),
      ctx({}),
    );
    expect(peekRes.status).toBe(200);
    const peekBody = await peekRes.json();
    expect(peekBody.available).toBe(true);
    const afterPeek = db
      .prepare(`SELECT COUNT(*) as n FROM runs WHERE job_id = ?`)
      .get(wfJobId) as { n: number };
    expect(afterPeek.n).toBe(0);

    const res = await workflowsNextGET(
      workflowRunnerReq(runnerA.apiKey, "http://x/api/workflows/next"),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBeDefined();
    expect(body.job.kind).toBe("workflow");

    const claimed = db.prepare(`SELECT COUNT(*) as n FROM runs WHERE job_id = ?`).get(wfJobId) as {
      n: number;
    };
    expect(claimed.n).toBe(1);
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

  it("rejects linking an org-B database to an org-A job", async () => {
    const { job: jobA, editor } = fixture();
    const other = otherOrgFixture();
    const req = userReq(editor.id, "http://x/", {
      method: "POST",
      body: JSON.stringify({ databaseId: other.database.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobDataPOST(req, ctx({ id: jobA.id }));
    expect(res.status).toBe(404);
    const linked = getDb()
      .prepare(`SELECT COUNT(*) as n FROM job_databases WHERE job_id = ? AND database_id = ?`)
      .get(jobA.id, other.database.id) as { n: number };
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

  it("the run's own agent can post activity", async () => {
    const { run, agent } = fixture();
    const req = agentReq(agent.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "working" }),
      headers: { "content-type": "application/json" },
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(201);
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
    const { project, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/jobs?projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({ name: "X", schedule: '{"every":60}', command: "echo hi" }),
      headers: { "content-type": "application/json" },
    });
    const res = await jobsPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe("workflow");
    expect(body.workflow_command).toBe("echo hi");
  });

  it("POST /api/jobs rejects an agentId (agent jobs use the agent endpoint)", async () => {
    const { org, project, editor, agent } = fixture();
    void org;
    const req = userReq(editor.id, `http://x/api/jobs?projectId=${project.id}`, {
      method: "POST",
      body: JSON.stringify({
        name: "X",
        schedule: '{"every":60}',
        command: "echo hi",
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
        prerunCommand: "exit 77",
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await agentJobsPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.agent_id).toBe(agent.id);
    expect(job.kind).toBe("agent");
    expect(job.prerun_command).toBe("exit 77");
  });
});

describe("workflow run reporting", () => {
  // Workflow runs have agent_id = null. A workflow runner scoped to the org
  // can report their status even though no agent owns them.
  it("an in-org workflow runner can set status on a workflow run", async () => {
    const { project } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      command: "echo hi",
    })!;
    const run = createRun(wfJob.id, null)!;
    const runner = createWorkflowRunner(project.org_id, "Server")!;
    // status route is PUT
    const putReq = workflowRunnerReq(runner.apiKey, "http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: { "content-type": "application/json" },
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(200);
  });

  it("a workflow runner cannot set status on an agent run", async () => {
    const { org, run } = fixture();
    const runner = createWorkflowRunner(org.id, "Server")!;
    const putReq = workflowRunnerReq(runner.apiKey, "http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: { "content-type": "application/json" },
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });

  it("an agent cannot set status on a workflow run", async () => {
    const { project, agent } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      command: "echo hi",
    })!;
    const run = createRun(wfJob.id, null)!;
    const putReq = agentReq(agent.apiKey, "http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: { "content-type": "application/json" },
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });

  it("an out-of-org workflow runner cannot touch a workflow run", async () => {
    const { project } = fixture();
    const wfJob = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      command: "echo hi",
    })!;
    const run = createRun(wfJob.id, null)!;
    const other = otherOrgFixture();
    const runner = createWorkflowRunner(other.org.id, "Other")!;
    const putReq = new NextRequest("http://x/", {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
      headers: { authorization: `Bearer ${runner.apiKey}`, "content-type": "application/json" },
    });
    const res = await runStatusPUT(putReq, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });
});

describe("agent self-ownership (within an org)", () => {
  it("a workflow runner cannot trigger an agent job", async () => {
    const { org, job } = fixture();
    const runner = createWorkflowRunner(org.id, "Server")!;
    const req = workflowRunnerReq(runner.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(403);
  });

  it("an agent cannot trigger another agent's job in the same org", async () => {
    const { project, job } = fixture(); // job belongs to agent A
    const agentB = createAgent(project.id, "DevB"); // same project/org, different agent
    const req = agentReq(agentB.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(404);
  });

  it("an agent can trigger its own job", async () => {
    const { job, agent } = fixture();
    const req = agentReq(agent.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await jobTriggerPOST(req, ctx({ id: job.id }));
    expect(res.status).toBe(201);
  });

  // Regression: the runner reads GET /api/runs/:id/status after a CLI exits to
  // see whether the agent set a final status. The full run detail (GET
  // /api/runs/:id) is user/admin-only, so without this agent-readable endpoint
  // the runner always read "running" and wrongly force-failed every run.
  it("an agent can read its own run's status", async () => {
    const { agent, run } = fixture();
    const req = agentReq(agent.apiKey, "http://x/");
    const res = await runStatusGET(req, ctx({ id: run.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("running");
  });

  it("an agent cannot read another agent's run status in the same org", async () => {
    const { project, run } = fixture();
    const agentB = createAgent(project.id, "DevB");
    const req = agentReq(agentB.apiKey, "http://x/");
    const res = await runStatusGET(req, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });

  it("an agent cannot write data as another agent in the same org", async () => {
    const { project, agent } = fixture(); // agent A
    const agentB = createAgent(project.id, "DevB"); // same org, different agent
    const req = agentReq(agentB.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({ name: "tbl", columns: [{ name: "c", type: "TEXT" }] }),
      headers: { "content-type": "application/json" },
    });
    const res = await agentDataPOST(req, ctx({ id: agent.id }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workflow-runners (create runner)", () => {
  it("editor creates a runner; the connect blob decodes to {url,runnerId,apiKey,name}", async () => {
    const { org, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/workflow-runners?orgId=${org.id}`, {
      method: "POST",
      body: JSON.stringify({ name: "CI", labels: ["linux"] }),
      headers: { "content-type": "application/json" },
    });
    const res = await workflowRunnersPOST(req, ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("CI");
    expect(body.connect).toMatch(/^npm run harbour -- workflow connect /);

    const blob = body.connect.replace("npm run harbour -- workflow connect ", "");
    const decoded = JSON.parse(Buffer.from(blob, "base64").toString("utf-8"));
    expect(decoded).toMatchObject({
      runnerId: body.id,
      apiKey: body.apiKey,
      name: "CI",
    });
    expect(typeof decoded.url).toBe("string");
  });

  it("rejects an empty name with 400", async () => {
    const { org, editor } = fixture();
    const req = userReq(editor.id, `http://x/api/workflow-runners?orgId=${org.id}`, {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
      headers: { "content-type": "application/json" },
    });
    const res = await workflowRunnersPOST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("a viewer cannot create a runner (editor role enforced)", async () => {
    const { org, viewer } = fixture();
    const req = userReq(viewer.id, `http://x/api/workflow-runners?orgId=${org.id}`, {
      method: "POST",
      body: JSON.stringify({ name: "CI" }),
      headers: { "content-type": "application/json" },
    });
    const res = await workflowRunnersPOST(req, ctx({}));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/runs/:id/activity (workflow_runner guard)", () => {
  it("a workflow runner cannot post to an agent run's thread (403)", async () => {
    const { org, run } = fixture(); // run belongs to an agent job (kind 'agent')
    const runner = createWorkflowRunner(org.id, "CI");
    const req = workflowRunnerReq(runner.apiKey, "http://x/", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const res = await activityPOST(req, ctx({ id: run.id }));
    expect(res.status).toBe(403);
  });
});
