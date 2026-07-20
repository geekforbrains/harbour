import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateRunner,
  createAgent,
  createProject,
  createRunner,
  createWorkflow,
  deleteRunner,
  getRunnerById,
  listRunners,
  touchRunnerPolled,
  updateAgent,
  updateJob,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Setup / Teardown — fresh in-memory v2 DB per test (mirrors the other suites)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// runners registry — the instance-level table that replaces runners.json
// ---------------------------------------------------------------------------

describe("createRunner", () => {
  it("mints a local runner with a plaintext token returned exactly once", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    expect(runner.id).toBeTruthy();
    expect(runner.tier).toBe("local");
    expect(runner.token).toMatch(/^hbrn_[0-9a-f]{64}$/);
    // The plaintext token is never persisted — only its hash.
    const row = getDb().prepare(`SELECT token_hash FROM runners WHERE id = ?`).get(runner.id) as {
      token_hash: string;
    };
    expect(row.token_hash).toBeTruthy();
    expect(row.token_hash).not.toBe(runner.token);
  });

  it("defaults a local runner to unscoped (null scope) and no authorized labels restriction", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    const fetched = getRunnerById(runner.id)!;
    expect(fetched.scope).toBeNull();
    expect(fetched.tier).toBe("local");
  });

  it("stores authorized labels and scope for a remote runner", () => {
    const runner = createRunner({
      name: "GPU box",
      tier: "remote",
      labels: ["gpu", "gpu", "  "],
      scope: { agentId: "agent-1" },
    });
    const fetched = getRunnerById(runner.id)!;
    expect(fetched.tier).toBe("remote");
    // labels de-duped and trimmed of blanks
    expect(fetched.labels).toEqual(["gpu"]);
    expect(fetched.scope).toEqual({ agentId: "agent-1" });
  });

  it("mints unique tokens across runners", () => {
    const a = createRunner({ name: "A", tier: "local" });
    const b = createRunner({ name: "B", tier: "local" });
    expect(a.token).not.toBe(b.token);
  });
});

describe("authenticateRunner", () => {
  it("resolves a runner from its plaintext token", () => {
    const created = createRunner({ name: "Local pool", tier: "local" });
    const auth = authenticateRunner(created.token)!;
    expect(auth).toBeTruthy();
    expect(auth.id).toBe(created.id);
    expect(auth.tier).toBe("local");
    expect(auth.name).toBe("Local pool");
  });

  it("returns null for an unknown token", () => {
    createRunner({ name: "Local pool", tier: "local" });
    expect(authenticateRunner("hbrn_deadbeef")).toBeNull();
  });

  it("parses labels and scope back into structured values", () => {
    const created = createRunner({
      name: "Scoped",
      tier: "remote",
      labels: ["gpu"],
      scope: { agentId: "agent-1" },
    });
    const auth = authenticateRunner(created.token)!;
    expect(auth.labels).toEqual(["gpu"]);
    expect(auth.scope).toEqual({ agentId: "agent-1" });
  });
});

describe("listRunners / getRunnerById", () => {
  it("lists every runner instance-wide", () => {
    createRunner({ name: "Local pool", tier: "local" });
    createRunner({ name: "GPU box", tier: "remote", labels: ["gpu"] });
    const all = listRunners();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.name).sort()).toEqual(["GPU box", "Local pool"]);
    // No plaintext token leaks through the list shape.
    for (const r of all) {
      expect((r as Record<string, unknown>).token).toBeUndefined();
      expect((r as Record<string, unknown>).token_hash).toBeUndefined();
    }
  });

  it("returns null for an unknown runner id", () => {
    expect(getRunnerById("nope")).toBeNull();
  });
});

describe("touchRunnerPolled", () => {
  it("stamps last_polled_at and records advertised capabilities", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    expect(getRunnerById(runner.id)!.last_polled_at).toBeNull();

    touchRunnerPolled(runner.id, {
      kinds: ["agent", "workflow"],
      clis: ["claude", "codex"],
      labels: ["local"],
    });

    const fetched = getRunnerById(runner.id)!;
    expect(fetched.last_polled_at).toBeGreaterThan(0);
    expect(fetched.capabilities).toEqual({
      kinds: ["agent", "workflow"],
      clis: ["claude", "codex"],
      labels: ["local"],
    });
  });

  it("updates last_polled_at without capabilities when none advertised", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    touchRunnerPolled(runner.id);
    expect(getRunnerById(runner.id)!.last_polled_at).toBeGreaterThan(0);
  });
});

describe("deleteRunner", () => {
  it("removes a runner from the registry", () => {
    const runner = createRunner({ name: "Local pool", tier: "local" });
    deleteRunner(runner.id);
    expect(getRunnerById(runner.id)).toBeNull();
    expect(authenticateRunner(runner.token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// placement columns — agents + workflow jobs default to 'local'
// ---------------------------------------------------------------------------

describe("placement defaults", () => {
  it("defaults a new agent's placement to 'local'", () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Worker");
    const row = getDb().prepare(`SELECT placement FROM agents WHERE id = ?`).get(agent.id) as {
      placement: string;
    };
    expect(row.placement).toBe("local");
  });

  it("defaults a new workflow job's placement to 'local'", () => {
    const project = createProject("Site")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo sync" },
    })!;
    const row = getDb().prepare(`SELECT placement FROM jobs WHERE id = ?`).get(wf.id) as {
      placement: string;
    };
    expect(row.placement).toBe("local");
  });

  it("honors an explicit placement on agent creation", () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "GPU worker", undefined, { placement: "gpu" });
    const row = getDb().prepare(`SELECT placement FROM agents WHERE id = ?`).get(agent.id) as {
      placement: string;
    };
    expect(row.placement).toBe("gpu");
  });

  it("updateAgent edits placement (and falls back to 'local' when blanked)", () => {
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "Worker");
    updateAgent(agent.id, { placement: "gpu" });
    expect(
      (
        getDb().prepare(`SELECT placement FROM agents WHERE id = ?`).get(agent.id) as {
          placement: string;
        }
      ).placement,
    ).toBe("gpu");
    updateAgent(agent.id, { placement: "  " });
    expect(
      (
        getDb().prepare(`SELECT placement FROM agents WHERE id = ?`).get(agent.id) as {
          placement: string;
        }
      ).placement,
    ).toBe("local");
  });

  it("updateJob edits a workflow job's placement", () => {
    const project = createProject("Site")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo sync" },
    })!;
    updateJob(wf.id, { placement: "remote-1" });
    expect(
      (
        getDb().prepare(`SELECT placement FROM jobs WHERE id = ?`).get(wf.id) as {
          placement: string;
        }
      ).placement,
    ).toBe("remote-1");
  });
});

// ---------------------------------------------------------------------------
// runs carry a denormalized placement copied from the agent / job at creation
// ---------------------------------------------------------------------------

describe("runs.placement denormalization", () => {
  it("copies the agent's placement onto an agent run at creation", async () => {
    const { createJob, createRun } = await import("@/lib/db/queries");
    const project = createProject("Site")!;
    const agent = createAgent(project.id, "GPU worker", undefined, { placement: "gpu" });
    const job = createJob(project.id, agent.id, { name: "Daily", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;
    const row = getDb().prepare(`SELECT placement FROM runs WHERE id = ?`).get(run.id) as {
      placement: string;
    };
    expect(row.placement).toBe("gpu");
  });

  it("copies a workflow job's placement onto a workflow run at creation", async () => {
    const { createRun } = await import("@/lib/db/queries");
    const project = createProject("Site")!;
    const wf = createWorkflow(project.id, {
      name: "Sync",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo sync" },
      placement: "remote-1",
    })!;
    const run = createRun(wf.id, null)!;
    const row = getDb().prepare(`SELECT placement FROM runs WHERE id = ?`).get(run.id) as {
      placement: string;
    };
    expect(row.placement).toBe("remote-1");
  });
});
