import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOrg,
  createProject,
  createRunner,
  createWorkflow,
  getRunById,
  runningCountsByRunner,
  stalledPlacements,
  touchRunnerPolled,
  triggerJobRun,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { claim, localRunner } from "./support/claim";

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
afterEach(() => resetDb());

function workflow(placement: string) {
  const org = createOrg("Acme")!;
  const project = createProject(org.id, "Site")!;
  const wf = createWorkflow(org.id, project.id, {
    name: "Sync",
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo sync" },
    placement,
  })!;
  return { org, project, wf };
}

describe("stalledPlacements (absent-runner surface)", () => {
  it("flags a placement with queued work but no live runner", () => {
    const { org, wf } = workflow("gpu");
    triggerJobRun(wf.id); // a scheduled run, placement 'gpu'
    expect(stalledPlacements(org.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("clears once a live runner advertises that placement label", () => {
    const { org, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    // The runner polled just now, advertising the 'gpu' label.
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    expect(stalledPlacements(org.id)).toEqual([]);
  });

  it("still flags when the only matching runner polled too long ago (stale)", () => {
    const { org, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    // Backdate its poll well outside the live window.
    getDb()
      .prepare(`UPDATE runners SET last_polled_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 600, runner.id);
    expect(stalledPlacements(org.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("still flags when a live runner over-advertises a label it isn't authorized for", () => {
    const { org, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    // Authorized only for 'cpu', but the host advertises 'gpu' too — the claim
    // path refuses 'gpu', so it must NOT count as served.
    const runner = createRunner({ name: "CPU box", tier: "remote", labels: ["cpu"] });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["cpu", "gpu"] });
    expect(stalledPlacements(org.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("still flags when the only matching runner is scoped to a different org", () => {
    const { org, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    const otherOrg = createOrg("Beta")!;
    // A live runner advertising 'gpu' but scoped to another org can't serve us.
    const runner = createRunner({
      name: "Other-org GPU",
      tier: "remote",
      labels: ["gpu"],
      scope: { orgId: otherOrg.id },
    });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    expect(stalledPlacements(org.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("returns nothing when there is no queued work", () => {
    const { org } = workflow("gpu");
    expect(stalledPlacements(org.id)).toEqual([]);
  });
});

describe("runningCountsByRunner + claimed_by surfacing", () => {
  it("counts in-flight runs per claiming runner and names the claimer on the run", () => {
    const { wf } = workflow("local");
    getDb().prepare(`UPDATE jobs SET next_run_at = 1 WHERE id = ?`).run(wf.id);

    const runner = localRunner({ name: "Local pool" });
    const payload = claim(runner)!; // claims the workflow → running, claimed_by runner
    expect(payload).toBeTruthy();

    expect(runningCountsByRunner()[runner.id]).toBe(1);
    const run = getRunById(payload.run.id) as { claimed_by_name: string; claimed_by_tier: string };
    expect(run.claimed_by_name).toBe("Local pool");
    expect(run.claimed_by_tier).toBe("local");
  });
});
