import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { createUser } from "@/lib/db/users";
import { decrypt } from "@/lib/encryption";
// Full v1 → v2 round-trip: seed a v1-shaped fixture DB, run the real migrator
// (bin/lib/migrate.mjs) into a fresh v2 DB built by the actual TS schema, then
// assert the result through the v2 layer (raw queries + the real decrypt, which
// proves secrets were re-encrypted under the new key).
import { migrateFromV1 } from "../../bin/lib/migrate.mjs";
import { seedV1Fixture } from "../../scripts/seed-v1-fixture.mjs";

let tmp: string;
let rdb: Database.Database;
let report: ReturnType<typeof migrateFromV1>;
let fixture: ReturnType<typeof seedV1Fixture>;

// biome-ignore lint/suspicious/noExplicitAny: rows from dynamic raw test queries
type Row = any;
const one = (sql: string, ...args: unknown[]): Row => rdb.prepare(sql).get(...args);
const all = (sql: string, ...args: unknown[]): Row[] => rdb.prepare(sql).all(...args);
const projectId = (name: string) => one(`SELECT id FROM projects WHERE name = ?`, name)?.id;
const agent = (name: string) => one(`SELECT * FROM agents WHERE name = ?`, name);
const job = (name: string) => one(`SELECT * FROM jobs WHERE name = ?`, name);
const doc = (title: string) => one(`SELECT * FROM docs WHERE title = ?`, title);
const docContent = (id: string) =>
  one(
    `SELECT content FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    id,
  )?.content ?? "";
const envVar = (name: string) => one(`SELECT * FROM env_vars WHERE name = ?`, name);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-mig-"));
  const v1dir = path.join(tmp, "v1");
  const v2home = path.join(tmp, "v2");
  fs.mkdirSync(v2home, { recursive: true });

  process.env.HARBOUR_HOME = v2home;
  process.env.HARBOUR_DB_PATH = path.join(v2home, "harbour.db");
  process.env.HARBOUR_ENCRYPTION_KEY = "";

  fixture = seedV1Fixture({ dir: v1dir });

  // Fresh v2 DB via the real TS schema; this also writes v2home/encryption.key.
  const v2DbPath = process.env.HARBOUR_DB_PATH;
  const db = new Database(v2DbPath);
  setDb(db);
  initializeSchema(db);
  createUser(fixture.adminEmail, "adminpw", "Admin", { isInstanceAdmin: true });
  db.close();
  resetDb();

  report = migrateFromV1({
    fromDir: v1dir,
    toDb: v2DbPath,
    orgName: "Acme",
    now: new Date("2026-03-15T12:00:00Z"),
  });

  rdb = new Database(v2DbPath);
  setDb(rdb);
});

afterAll(() => {
  rdb?.close();
  resetDb();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("v1 → v2 migration", () => {
  it("creates one org carrying the v1 timezone", () => {
    const orgs = all(`SELECT * FROM orgs`);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Acme");
    expect(JSON.parse(orgs[0].settings).timezone).toBe("America/New_York");
    expect(one(`SELECT value FROM settings WHERE key = 'timezone'`).value).toBe("America/New_York");
  });

  it("reuses the instance admin and migrates other users password-less", () => {
    const admin = one(`SELECT * FROM users WHERE email = ?`, fixture.adminEmail);
    expect(admin.is_instance_admin).toBe(1);
    expect(admin.password_hash).not.toBeNull();

    const alice = one(`SELECT * FROM users WHERE email = 'alice@test.dev'`);
    expect(alice.password_hash).toBeNull();
    expect(alice.is_instance_admin).toBe(0);
    // both belong to the org
    expect(all(`SELECT * FROM memberships`).length).toBe(2);
  });

  it("maps v1 projects plus a Default for unprojected agents", () => {
    expect(all(`SELECT name FROM projects ORDER BY name`).map((p) => p.name)).toEqual([
      "Alpha",
      "Beta",
      "Default",
    ]);
  });

  it("migrates agents with CLI config, placement, and project assignment", () => {
    const claude = agent("Claude Dev");
    expect(claude.cli).toBe("claude");
    expect(claude.model).toBe("opus");
    expect(claude.thinking).toBe("high");
    expect(claude.eager).toBe(1);
    expect(claude.placement).toBe("local");
    expect(claude.project_id).toBe(projectId("Alpha"));

    expect(agent("Remote Worker").placement).toBe("remote");
    expect(agent("Remote Worker").project_id).toBe(projectId("Beta"));

    // multi-project agent lands in its first project
    expect(agent("Multi Agent").project_id).toBe(projectId("Alpha"));

    // external (no-CLI) agent goes to Default
    const ext = agent("External Bot");
    expect(ext.cli).toBeNull();
    expect(ext.project_id).toBe(projectId("Default"));
  });

  it("translates the three job shapes", () => {
    // plain agent job
    const daily = job("Daily Report");
    expect(daily.kind).toBe("agent");
    expect(daily.agent_id).toBe(agent("Claude Dev").id);
    expect(daily.project_id).toBe(projectId("Alpha"));
    expect(daily.instructions).toBe("Write the daily report");
    expect(daily.model).toBe("opus");
    expect(daily.title_format).toBe("Report {date}");
    expect(daily.prerun_runtime).toBeNull();
    expect(daily.active).toBe(1);
    expect(daily.next_run_at).not.toBeNull();

    // combo job → agent job with a prerun gate
    const gated = job("Gated Job");
    expect(gated.kind).toBe("agent");
    expect(gated.prerun_runtime).toBe("bash");
    expect(gated.prerun_script).toBe("test -f /tmp/go");

    // workflow-only with agent → workflow job inheriting placement
    const cleanup = job("Cleanup");
    expect(cleanup.kind).toBe("workflow");
    expect(cleanup.agent_id).toBeNull();
    expect(cleanup.workflow_runtime).toBe("bash");
    expect(cleanup.workflow_script).toBe("rm -rf /tmp/x");
    expect(cleanup.placement).toBe("remote");
    expect(cleanup.project_id).toBe(projectId("Beta"));
    expect(cleanup.next_run_at).not.toBeNull();
  });

  it("scopes agentless workflows by their project link (or org-level)", () => {
    expect(job("Nightly Backup").project_id).toBe(projectId("Alpha"));
    expect(job("Global Sweep").project_id).toBeNull(); // org-level
  });

  it("migrates inactive jobs paused, drops one-off, and pauses bad schedules", () => {
    const paused = job("Paused Job");
    expect(paused.active).toBe(0);
    expect(paused.next_run_at).toBeNull();

    expect(job("One Time")).toBeUndefined();
    expect(report.counts.skippedOneOff).toBe(1);

    const broken = job("Broken Sched");
    expect(broken.active).toBe(0);
    expect(broken.next_run_at).toBeNull();
  });

  it("migrates docs with correct tier and latest content", () => {
    const brand = doc("Brand Guide");
    expect(brand.project_id).toBe(projectId("Alpha"));
    expect(brand.pinned).toBe(1);
    expect(docContent(brand.id)).toBe("v2 brand content (latest)");

    expect(doc("Shared Strategy").project_id).toBeNull();
    expect(doc("Multi Doc").project_id).toBeNull(); // many projects → org-level
    expect(docContent(doc("Empty Doc").id)).toBe(""); // no revision
  });

  it("re-encrypts secrets under the new key with correct tier", () => {
    const api = envVar("API_KEY");
    expect(api.project_id).toBe(projectId("Alpha"));
    expect(decrypt(api.encrypted_value)).toBe("secret-123");

    const global = envVar("GLOBAL_TOKEN");
    expect(global.project_id).toBeNull();
    expect(global.pinned).toBe(1);
    expect(decrypt(global.encrypted_value)).toBe("tok-xyz");
  });

  it("recreates tables with rows and column definitions", () => {
    const leads = one(`SELECT * FROM tables WHERE name = 'leads'`);
    expect(leads.project_id).toBe(projectId("Alpha"));
    const leadRows = all(`SELECT * FROM "${leads.table_name}" ORDER BY score`);
    expect(leadRows).toHaveLength(3);
    expect(leadRows.map((r) => r.name)).toContain("Acme");
    // column definition preserved (NOT NULL DEFAULT 0)
    const scoreCol = (rdb.pragma(`table_info("${leads.table_name}")`) as Row[]).find(
      (c) => c.name === "score",
    );
    expect(scoreCol.notnull).toBe(1);
    expect(String(scoreCol.dflt_value)).toBe("0");

    const metrics = one(`SELECT * FROM tables WHERE name = 'global_metrics'`);
    expect(metrics.project_id).toBeNull();
    expect(all(`SELECT * FROM "${metrics.table_name}"`)).toHaveLength(2);
    expect(report.counts.tableRows).toBe(5);
  });

  it("relinks job resources and enforces v2 tier rules", () => {
    const daily = job("Daily Report");
    expect(all(`SELECT * FROM job_docs WHERE job_id = ?`, daily.id)).toHaveLength(1);
    expect(all(`SELECT * FROM job_env_vars WHERE job_id = ?`, daily.id)).toHaveLength(2);
    expect(all(`SELECT * FROM job_tables WHERE job_id = ?`, daily.id)).toHaveLength(1);

    // org-level workflow linking a project-scoped secret is skipped by the guard
    const sweep = job("Global Sweep");
    expect(all(`SELECT * FROM job_env_vars WHERE job_id = ?`, sweep.id)).toHaveLength(0);
  });

  it("carries admin API keys verbatim so they keep working", () => {
    const keys = all(`SELECT * FROM admin_api_keys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].api_key_hash).toBe(fixture.ids.adminKeyHash);
    expect(keys[0].created_by_user_id).toBe(
      one(`SELECT id FROM users WHERE email = ?`, fixture.adminEmail).id,
    );
  });

  it("reports warnings for the lossy/ambiguous cases", () => {
    const text = report.warnings.join("\n");
    expect(text).toMatch(/Multi Agent/);
    expect(text).toMatch(/External Bot/);
    expect(text).toMatch(/Broken Sched/);
    expect(report.counts.agents).toBe(4);
    expect(report.counts.workflows).toBe(3);
    expect(report.counts.agentJobs).toBe(4);
  });

  it("reports v1 workspaces to reconcile with old → new paths", () => {
    const byAgent = new Map(report.workspaces.map((w) => [w.agent, w]));
    // Claude Dev had a git repo in its flat v1 workspace → flagged with the
    // nested v2 destination under <org>/<project>/<agent>.
    const claude = byAgent.get("Claude Dev");
    expect(claude).toBeTruthy();
    expect(claude?.hasGit).toBe(true);
    expect(claude?.oldPath).toMatch(/workspaces\/claude-dev$/);
    expect(claude?.newPath).toMatch(/workspaces\/[^/]+\/alpha\/claude-dev$/);

    // External Bot had a non-git workspace → reported, hasGit false, lands in Default.
    const ext = byAgent.get("External Bot");
    expect(ext).toBeTruthy();
    expect(ext?.hasGit).toBe(false);
    expect(ext?.newPath).toMatch(/workspaces\/[^/]+\/default\/external-bot$/);

    // Agents without a populated v1 workspace aren't reported.
    expect(byAgent.has("Multi Agent")).toBe(false);
  });

  it("produces a v2 database that passes the schema verifier", async () => {
    const { diffSchema } = await import("@/lib/db/schema");
    expect(diffSchema(rdb)).toEqual([]);
  });
});
