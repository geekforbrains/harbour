import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createJob,
  createProject,
  createRunner,
  createWorkflow,
  getRunById,
  hasLiveRunnerForAgent,
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
  const project = createProject("Site")!;
  const wf = createWorkflow(project.id, {
    name: "Sync",
    schedule: '{"every":60}',
    workflow: { runtime: "bash", content: "echo sync" },
    placement,
  })!;
  return { project, wf };
}

describe("stalledPlacements (absent-runner surface)", () => {
  it("flags a placement with queued work but no live runner", () => {
    const { project, wf } = workflow("gpu");
    triggerJobRun(wf.id); // a scheduled run, placement 'gpu'
    expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("flags across all projects when no projectId is given", () => {
    const { wf } = workflow("gpu");
    triggerJobRun(wf.id);
    expect(stalledPlacements()).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("clears once a live runner advertises that placement label", () => {
    const { project, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    // The runner polled just now, advertising the 'gpu' label.
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    expect(stalledPlacements(project.id)).toEqual([]);
  });

  it("still flags when the only matching runner polled too long ago (stale)", () => {
    const { project, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    // Backdate its poll well outside the live window.
    getDb()
      .prepare(`UPDATE runners SET last_polled_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 600, runner.id);
    expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("still flags when a live runner over-advertises a label it isn't authorized for", () => {
    const { project, wf } = workflow("gpu");
    triggerJobRun(wf.id);
    // Authorized only for 'cpu', but the host advertises 'gpu' too — the claim
    // path refuses 'gpu', so it must NOT count as served.
    const runner = createRunner({ name: "CPU box", tier: "remote", labels: ["cpu"] });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["cpu", "gpu"] });
    expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
  });

  it("returns nothing when there is no queued work", () => {
    const { project } = workflow("gpu");
    expect(stalledPlacements(project.id)).toEqual([]);
  });

  // A runner only "serves" a run it could actually claim — an agent-scoped
  // runner never claims workflow runs or other agents' runs, so it must not
  // suppress the banner for them.
  describe("claim-eligibility mirroring (scope, kind, CLI)", () => {
    /** An agent on 'gpu' with a job, plus one queued run for it. */
    function queuedAgentRun(project: { id: string }, name: string) {
      const agent = createAgent(project.id, name, undefined, { cli: "claude", placement: "gpu" })!;
      const job = createJob(project.id, agent.id, {
        name: `${name} job`,
        schedule: '{"every":60}',
      })!;
      triggerJobRun(job.id);
      return agent;
    }

    it("an agent-scoped runner does NOT suppress the banner for workflow runs", () => {
      const { project, wf } = workflow("gpu");
      triggerJobRun(wf.id);
      const agent = queuedAgentRun(project, "Dev");
      const runner = createRunner({
        name: "Dev-only box",
        tier: "remote",
        labels: ["gpu"],
        scope: { agentId: agent.id },
      });
      touchRunnerPolled(runner.id, {
        kinds: ["agent", "workflow"],
        clis: ["claude"],
        labels: ["gpu"],
      });
      // The agent's own run is served; the workflow run is not.
      expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
    });

    it("an agent-scoped runner does NOT suppress the banner for another agent's runs", () => {
      const project = createProject("Site")!;
      const dev = queuedAgentRun(project, "Dev");
      queuedAgentRun(project, "Ops");
      const runner = createRunner({
        name: "Dev-only box",
        tier: "remote",
        labels: ["gpu"],
        scope: { agentId: dev.id },
      });
      touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
      // Dev's run is served; Ops' run still stalls.
      expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
    });

    it("an agent-scoped runner DOES suppress the banner for its own agent's runs", () => {
      const project = createProject("Site")!;
      const dev = queuedAgentRun(project, "Dev");
      const runner = createRunner({
        name: "Dev-only box",
        tier: "remote",
        labels: ["gpu"],
        scope: { agentId: dev.id },
      });
      touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
      expect(stalledPlacements(project.id)).toEqual([]);
    });

    it("a workflow-only runner does NOT suppress the banner for agent runs", () => {
      const project = createProject("Site")!;
      queuedAgentRun(project, "Dev");
      const runner = createRunner({ name: "WF box", tier: "remote", labels: ["gpu"] });
      touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
      expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
    });

    it("a runner without the agent's CLI does NOT suppress the banner for its runs", () => {
      const project = createProject("Site")!;
      queuedAgentRun(project, "Dev"); // agent cli 'claude'
      const runner = createRunner({ name: "Codex box", tier: "remote", labels: ["gpu"] });
      touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["codex"], labels: ["gpu"] });
      expect(stalledPlacements(project.id)).toEqual([{ placement: "gpu", count: 1 }]);
    });
  });
});

describe("hasLiveRunnerForAgent (pre-flight, no queued run required)", () => {
  function devAgent(project: { id: string }, placement = "gpu", name = "Dev") {
    return createAgent(project.id, name, undefined, { cli: "claude", placement })!;
  }

  it("is false with no runners registered at all", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is true once a live runner advertises the placement + CLI", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(true);
  });

  it("is false when the runner has never polled (no capabilities yet)", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is false once the only matching runner's poll goes stale", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const runner = createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
    getDb()
      .prepare(`UPDATE runners SET last_polled_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 600, runner.id);
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is false when a remote runner advertises the label but isn't authorized for it", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    // Authorized only for 'cpu'; advertising 'gpu' too doesn't count — the
    // claim path would refuse it, so this must not read as available either.
    const runner = createRunner({ name: "CPU box", tier: "remote", labels: ["cpu"] });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["cpu", "gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is true for a local-tier runner even without an authorized label list", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project, "local");
    const runner = createRunner({ name: "Local pool", tier: "local" });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["local"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(true);
  });

  it("is false when the only live runner lacks the agent's CLI", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const runner = createRunner({ name: "Codex box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["codex"], labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is false when the only live runner only advertises the workflow kind", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const runner = createRunner({ name: "WF box", tier: "remote", labels: ["gpu"] });
    touchRunnerPolled(runner.id, { kinds: ["workflow"], clis: [], labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is false when a runner scoped to a different agent is the only one live", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const other = devAgent(project, "gpu", "Ops");
    const runner = createRunner({
      name: "Other-only box",
      tier: "remote",
      labels: ["gpu"],
      scope: { agentId: other.id },
    });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(false);
  });

  it("is true when a runner scoped to this agent is live", () => {
    const project = createProject("Site")!;
    const agent = devAgent(project);
    const runner = createRunner({
      name: "Dev-only box",
      tier: "remote",
      labels: ["gpu"],
      scope: { agentId: agent.id },
    });
    touchRunnerPolled(runner.id, { kinds: ["agent"], clis: ["claude"], labels: ["gpu"] });
    expect(
      hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id }),
    ).toBe(true);
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
