import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as jobDocsPOST } from "@/app/api/jobs/[id]/docs/route";
import { GET as jobsGET, POST as jobsPOST } from "@/app/api/jobs/route";
import {
  addMembership,
  createDatabase,
  createDoc,
  createEnvVar,
  createJob,
  createOrg,
  createProject,
  createSession,
  createUser,
  createWorkflow,
  getComposedDatabasesForJob,
  getComposedDocsForJob,
  getDecryptedEnvVarsForJob,
  getJobById,
  getNextWorkflowRun,
  linkDatabaseToJob,
  linkDocToJob,
  linkEnvVarToJob,
  listAllJobs,
  listRunningRuns,
  listRunsHistory,
  updateJob,
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

const SCHEDULE = '{"every":60}';
const HOUR_AGO = () => Math.floor(Date.now() / 1000) - 3600;

function fixture() {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  return { org, project };
}

function orgWorkflow(orgId: string, extra: { docIds?: string[]; envVarIds?: string[] } = {}) {
  return createWorkflow(orgId, null, {
    name: "OrgWF",
    schedule: SCHEDULE,
    command: "echo org",
    ...extra,
  })!;
}

function projectWorkflow(orgId: string, projectId: string, name = "ProjWF") {
  return createWorkflow(orgId, projectId, {
    name,
    schedule: SCHEDULE,
    command: "echo proj",
  })!;
}

type ReqInit = { method?: string; body?: string; headers?: HeadersInit };

function userReq(userId: string, url: string, init: ReqInit = {}): NextRequest {
  const sessionId = createSession(userId);
  const headers = new Headers(init.headers);
  headers.set("cookie", `harbour_session=${sessionId}`);
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function editorFor(orgId: string) {
  const editor = createUser(`e-${orgId}@x.com`, "pw", "Editor")!;
  addMembership(editor.id, orgId, "editor");
  return editor;
}

// ===========================================================================
// createWorkflow — scope tiers (dual-tier like docs/env_vars/databases)
// ===========================================================================

describe("createWorkflow scope tiers", () => {
  it("creates an org-level workflow: org_id set, project_id NULL", () => {
    const { org } = fixture();
    const wf = orgWorkflow(org.id);
    expect(wf.kind).toBe("workflow");
    expect(wf.org_id).toBe(org.id);
    expect(wf.project_id).toBeNull();
  });

  it("creates a project-level workflow: both org_id and project_id set", () => {
    const { org, project } = fixture();
    const wf = projectWorkflow(org.id, project.id);
    expect(wf.org_id).toBe(org.id);
    expect(wf.project_id).toBe(project.id);
  });
});

// ===========================================================================
// Agent jobs remain strictly project-level
// ===========================================================================

describe("agent jobs are strictly project-level", () => {
  it("query layer: createJob derives the org from the project and throws without one", () => {
    expect(() => createJob("nope", null, { name: "AJ", schedule: SCHEDULE })).toThrow(
      "Project not found",
    );
  });

  it("schema: CHECK rejects an agent job with a NULL project_id", () => {
    const { org } = fixture();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, org_id, project_id, kind, name, schedule)
           VALUES ('j-agent-null', ?, NULL, 'agent', 'AJ', ?)`,
        )
        .run(org.id, SCHEDULE),
    ).toThrow(/CHECK/);
  });
});

// ===========================================================================
// Link guard — an org-level job may only link org-level resources of its org
// ===========================================================================

describe("org-level job link guard", () => {
  it("rejects a project-level doc with a clear message", () => {
    const { org, project } = fixture();
    const wf = orgWorkflow(org.id);
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;
    expect(() => linkDocToJob(wf.id, projDoc.id)).toThrow(
      "Org-level jobs can only link org-level docs",
    );
  });

  it("rejects a project-level env var with a clear message", () => {
    const { org, project } = fixture();
    const wf = orgWorkflow(org.id);
    const projVar = createEnvVar(org.id, project.id, "PROJ_VAR", "v")!;
    expect(() => linkEnvVarToJob(wf.id, projVar.id)).toThrow(
      "Org-level jobs can only link org-level env vars",
    );
  });

  it("rejects a project-level database with a clear message", () => {
    const { org, project } = fixture();
    const wf = orgWorkflow(org.id);
    const projDb = createDatabase(org.id, project.id, "projdb", [{ name: "v", type: "TEXT" }]);
    expect(() => linkDatabaseToJob(wf.id, projDb.id)).toThrow(
      "Org-level jobs can only link org-level databases",
    );
  });

  it("rejects an org-level resource belonging to a different org", () => {
    const { org } = fixture();
    const otherOrg = createOrg("Rival")!;
    const wf = orgWorkflow(org.id);
    const foreignDoc = createDoc(otherOrg.id, null, "Foreign", "f")!;
    expect(() => linkDocToJob(wf.id, foreignDoc.id)).toThrow(
      "Org-level jobs can only link org-level docs",
    );
  });

  it("links same-org org-level resources fine", () => {
    const { org } = fixture();
    const wf = orgWorkflow(org.id);
    const orgDoc = createDoc(org.id, null, "Org Doc", "o")!;
    const orgVar = createEnvVar(org.id, null, "ORG_VAR", "v")!;
    const orgDb = createDatabase(org.id, null, "orgdb", [{ name: "v", type: "TEXT" }]);

    linkDocToJob(wf.id, orgDoc.id);
    linkEnvVarToJob(wf.id, orgVar.id);
    linkDatabaseToJob(wf.id, orgDb.id);

    const job = getJobById(wf.id)!;
    expect(job.docs.map((d: { id: string }) => d.id)).toContain(orgDoc.id);
    expect(job.envVars.map((e: { id: string }) => e.id)).toContain(orgVar.id);
    expect(job.databases.map((d: { id: string }) => d.id)).toContain(orgDb.id);
  });

  it("project-level jobs still link both tiers as before", () => {
    const { org, project } = fixture();
    const wf = projectWorkflow(org.id, project.id);
    const orgDoc = createDoc(org.id, null, "Org Doc", "o")!;
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;

    linkDocToJob(wf.id, orgDoc.id);
    linkDocToJob(wf.id, projDoc.id);

    const ids = getJobById(wf.id)!.docs.map((d: { id: string }) => d.id);
    expect(ids).toContain(orgDoc.id);
    expect(ids).toContain(projDoc.id);
  });

  it("a violating createWorkflow rolls back atomically — no job row left behind", () => {
    const { org, project } = fixture();
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;
    expect(() => orgWorkflow(org.id, { docIds: [projDoc.id] })).toThrow(
      "Org-level jobs can only link org-level docs",
    );
    const count = getDb().prepare(`SELECT COUNT(*) as n FROM jobs`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("a violating updateJob rolls back atomically — existing links survive", () => {
    const { org, project } = fixture();
    const orgDoc = createDoc(org.id, null, "Org Doc", "o")!;
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;
    const wf = orgWorkflow(org.id, { docIds: [orgDoc.id] });

    expect(() => updateJob(wf.id, { name: "renamed", docIds: [projDoc.id] })).toThrow(
      "Org-level jobs can only link org-level docs",
    );

    const job = getJobById(wf.id)!;
    expect(job.name).toBe("OrgWF"); // the whole update rolled back, not just the links
    expect(job.docs.map((d: { id: string }) => d.id)).toEqual([orgDoc.id]);
  });
});

// ===========================================================================
// Composition — org-level jobs compose org tier + linked only (no project tier)
// ===========================================================================

describe("org-level job composition", () => {
  function seededScopes() {
    const { org, project } = fixture();
    const orgDoc = createDoc(org.id, null, "Org Doc", "org-content")!;
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "proj-content")!;
    createEnvVar(org.id, null, "ORG_VAR", "org-value");
    createEnvVar(org.id, project.id, "PROJ_VAR", "proj-value");
    // Same name in both tiers: a project-level value must never reach an
    // org-level job (no project tier to override from).
    createEnvVar(org.id, null, "SHARED", "org-shared");
    createEnvVar(org.id, project.id, "SHARED", "proj-shared");
    const orgDb = createDatabase(org.id, null, "orgdb", [{ name: "v", type: "TEXT" }]);
    const projDb = createDatabase(org.id, project.id, "projdb", [{ name: "v", type: "TEXT" }]);
    return { org, project, orgDoc, projDoc, orgDb, projDb };
  }

  it("composes org-tier docs/env/data only for an org-level job", () => {
    const { org, orgDoc, projDoc, orgDb, projDb } = seededScopes();
    const wf = orgWorkflow(org.id);

    const docIds = getComposedDocsForJob(wf.id).map((d) => d.id);
    expect(docIds).toContain(orgDoc.id);
    expect(docIds).not.toContain(projDoc.id);

    const env = getDecryptedEnvVarsForJob(wf.id);
    expect(env.ORG_VAR).toBe("org-value");
    expect(env.PROJ_VAR).toBeUndefined();
    expect(env.SHARED).toBe("org-shared");

    const dataIds = getComposedDatabasesForJob(wf.id).map((d) => d.id);
    expect(dataIds).toContain(orgDb.id);
    expect(dataIds).not.toContain(projDb.id);
  });

  it("still composes both tiers for a project-level job (regression)", () => {
    const { org, project, orgDoc, projDoc } = seededScopes();
    const wf = projectWorkflow(org.id, project.id);

    const docIds = getComposedDocsForJob(wf.id).map((d) => d.id);
    expect(docIds).toContain(orgDoc.id);
    expect(docIds).toContain(projDoc.id);

    const env = getDecryptedEnvVarsForJob(wf.id);
    expect(env.SHARED).toBe("proj-shared"); // project tier overrides org tier
  });
});

// ===========================================================================
// listAllJobs — dual-tier listing, same semantics as listDocs
// ===========================================================================

describe("listAllJobs dual-tier", () => {
  it("project filter returns the project's jobs plus org-level jobs", () => {
    const { org, project } = fixture();
    const projectB = createProject(org.id, "Other")!;
    const orgWf = orgWorkflow(org.id);
    const projWf = projectWorkflow(org.id, project.id);
    const otherWf = projectWorkflow(org.id, projectB.id, "OtherWF");

    const ids = (listAllJobs(org.id, project.id) as { id: string }[]).map((j) => j.id);
    expect(ids).toContain(orgWf.id);
    expect(ids).toContain(projWf.id);
    expect(ids).not.toContain(otherWf.id);
  });

  it("null project filter returns org-level jobs only, never another org's", () => {
    const { org, project } = fixture();
    const otherOrg = createOrg("Rival")!;
    const orgWf = orgWorkflow(org.id);
    const projWf = projectWorkflow(org.id, project.id);
    const foreignWf = orgWorkflow(otherOrg.id);

    const ids = (listAllJobs(org.id, null) as { id: string }[]).map((j) => j.id);
    expect(ids).toEqual([orgWf.id]);
    expect(ids).not.toContain(projWf.id);
    expect(ids).not.toContain(foreignWf.id);
  });
});

// ===========================================================================
// getNextWorkflowRun — org-level workflows are claimable, runs are dual-tier
// ===========================================================================

describe("org-level workflow runs", () => {
  function dueOrgWorkflow() {
    const { org, project } = fixture();
    const wf = orgWorkflow(org.id);
    getDb().prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`).run(HOUR_AGO(), wf.id);
    return { org, project, wf };
  }

  it("claims an org-level workflow run with org_id set and project_id NULL", () => {
    const { org, wf } = dueOrgWorkflow();

    const payload = getNextWorkflowRun(org.id)!;
    expect(payload.job.id).toBe(wf.id);
    expect(payload.job.kind).toBe("workflow");

    const run = getDb()
      .prepare(`SELECT org_id, project_id, status FROM runs WHERE id = ?`)
      .get(payload.run.id) as { org_id: string; project_id: string | null; status: string };
    expect(run.org_id).toBe(org.id);
    expect(run.project_id).toBeNull();
    expect(run.status).toBe("running");
  });

  it("another org's runner cannot claim it", () => {
    dueOrgWorkflow();
    const otherOrg = createOrg("Rival")!;
    expect(getNextWorkflowRun(otherOrg.id)).toBeNull();
  });

  it("org-level runs appear in project-filtered run lists (dual-tier display)", () => {
    const { org, project } = dueOrgWorkflow();
    const payload = getNextWorkflowRun(org.id)!;

    const running = (listRunningRuns(org.id, project.id) as { id: string }[]).map((r) => r.id);
    expect(running).toContain(payload.run.id);

    const history = listRunsHistory(org.id, { projectId: project.id });
    expect(history.runs.map((r: { id: string }) => r.id)).toContain(payload.run.id);
  });
});

// ===========================================================================
// updateJob — scope is fixed at creation
// ===========================================================================

describe("updateJob scope immutability", () => {
  it("ignores org/project keys in the update payload (both naming styles)", () => {
    const { org, project } = fixture();
    const otherOrg = createOrg("Rival")!;
    const wf = projectWorkflow(org.id, project.id);

    // The PUT route passes the raw body straight into updateJob, so a client
    // can put any keys it likes in there — the field whitelist must drop them.
    const sneaky = {
      name: "renamed",
      orgId: otherOrg.id,
      org_id: otherOrg.id,
      projectId: null,
      project_id: null,
    } as unknown as Parameters<typeof updateJob>[1];
    const updated = updateJob(wf.id, sneaky)!;

    expect(updated.name).toBe("renamed");
    expect(updated.org_id).toBe(org.id);
    expect(updated.project_id).toBe(project.id);
  });
});

// ===========================================================================
// Routes — org-level creation and guard errors surface as 400s
// ===========================================================================

describe("org-level workflow routes", () => {
  it("POST /api/jobs without projectId creates an org-level workflow", async () => {
    const { org } = fixture();
    const editor = editorFor(org.id);
    const res = await jobsPOST(
      userReq(editor.id, `http://x/api/jobs?orgId=${org.id}`, {
        method: "POST",
        body: JSON.stringify({ name: "OrgWF", schedule: SCHEDULE, command: "echo org" }),
        headers: { "content-type": "application/json" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe("workflow");
    expect(body.org_id).toBe(org.id);
    expect(body.project_id).toBeNull();
  });

  it("POST /api/jobs rejects a projectId from another org with 400", async () => {
    const { org } = fixture();
    const otherOrg = createOrg("Rival")!;
    const otherProject = createProject(otherOrg.id, "Theirs")!;
    const editor = editorFor(org.id);
    const res = await jobsPOST(
      userReq(editor.id, `http://x/api/jobs?orgId=${org.id}&projectId=${otherProject.id}`, {
        method: "POST",
        body: JSON.stringify({ name: "WF", schedule: SCHEDULE, command: "echo hi" }),
        headers: { "content-type": "application/json" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid projectId");
  });

  it("POST /api/jobs surfaces the link guard as a 400 with the clear message", async () => {
    const { org, project } = fixture();
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;
    const editor = editorFor(org.id);
    const res = await jobsPOST(
      userReq(editor.id, `http://x/api/jobs?orgId=${org.id}`, {
        method: "POST",
        body: JSON.stringify({
          name: "OrgWF",
          schedule: SCHEDULE,
          command: "echo org",
          docIds: [projDoc.id],
        }),
        headers: { "content-type": "application/json" },
      }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Org-level jobs can only link org-level docs");
  });

  it("GET /api/jobs with only orgId lists org-level jobs", async () => {
    const { org, project } = fixture();
    const orgWf = orgWorkflow(org.id);
    projectWorkflow(org.id, project.id);
    const editor = editorFor(org.id);
    const res = await jobsGET(userReq(editor.id, `http://x/api/jobs?orgId=${org.id}`), ctx({}));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((j) => j.id);
    expect(ids).toEqual([orgWf.id]);
  });

  it("POST /api/jobs/:id/docs on an org-level job rejects a project doc with 400", async () => {
    const { org, project } = fixture();
    const wf = orgWorkflow(org.id);
    const projDoc = createDoc(org.id, project.id, "Proj Doc", "p")!;
    const editor = editorFor(org.id);
    // Exercises withResourceAuth("job") on an org-level job — the org must
    // resolve from the denormalized jobs.org_id (there is no project to join).
    const res = await jobDocsPOST(
      userReq(editor.id, "http://x/", {
        method: "POST",
        body: JSON.stringify({ docId: projDoc.id }),
        headers: { "content-type": "application/json" },
      }),
      ctx({ id: wf.id }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Org-level jobs can only link org-level docs");
  });
});
