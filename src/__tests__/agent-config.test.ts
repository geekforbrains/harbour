import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createOrg,
  createProject,
  createRun,
  createWorkflow,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { getProvider, resolveRunConfig } from "../../bin/lib/providers.mjs";

// End-to-end coverage for the "harbour is the source of truth for agent config"
// model: the /next payload carries the agent's live cli/model/thinking, the
// runner resolves them (job override > agent default > runner-config fallback),
// and each CLI provider turns that into the right argv. The runner config is
// identity-only, so changing a model in the dashboard must reach the runner via
// the payload alone — these tests lock that contract for all three CLIs.

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

describe("agent remote flag", () => {
  it("defaults to local and persists when set", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;

    const local = createAgent(project.id, "Local Dev", undefined, { cli: "claude" });
    const remote = createAgent(project.id, "Mac Builder", undefined, {
      cli: "claude",
      remote: true,
    });

    expect(local.remote).toBe(false);
    expect(remote.remote).toBe(true);

    const row = getDb().prepare(`SELECT remote FROM agents WHERE id = ?`).get(remote.id) as {
      remote: number;
    };
    expect(row.remote).toBe(1);
  });
});

describe("/next payload carries live agent config", () => {
  it("includes the agent's cli/model/thinking/eager", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev", undefined, {
      cli: "codex",
      model: "gpt-5",
      thinking: "high",
      eager: true,
    });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    const payload = buildRunPayload(run.id)!;
    expect(payload.agent).toEqual({
      cli: "codex",
      model: "gpt-5",
      thinking: "high",
      eager: true,
    });
  });

  it("reflects a dashboard model change on the next run without touching the runner", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude", model: "sonnet" });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;

    const before = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(before.agent?.model).toBe("sonnet");

    // Simulate the dashboard editing the agent's model.
    getDb().prepare(`UPDATE agents SET model = 'opus' WHERE id = ?`).run(agent.id);

    const after = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(after.agent?.model).toBe("opus");
  });

  it("omits the agent block for a deterministic workflow run", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Website")!;
    const job = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      command: "echo hi",
    })!;
    const run = createRun(job.id, null)!;
    const payload = buildRunPayload(run.id)!;
    // No agent → no agent block. Workflow runs never spawn a CLI.
    expect(payload.agent).toBeUndefined();
    expect(payload.job.kind).toBe("workflow");
    expect(payload.job.command).toBe("echo hi");
  });
});

describe("resolveRunConfig precedence", () => {
  const fallback = { cli: "claude", model: "fallback-model", thinking: "fallback-effort" };

  it("uses the live agent defaults from the payload", () => {
    const payload = { agent: { cli: "codex", model: "gpt-5", thinking: "medium" }, job: {} };
    expect(resolveRunConfig(payload, fallback)).toEqual({
      cli: "codex",
      model: "gpt-5",
      thinking: "medium",
    });
  });

  it("lets a per-job model/thinking override the agent default", () => {
    const payload = {
      agent: { cli: "claude", model: "sonnet", thinking: "low" },
      job: { model: "opus", thinking: "high" },
    };
    expect(resolveRunConfig(payload, fallback)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });

  it("falls back to the runner config when the payload omits values (legacy runner)", () => {
    expect(resolveRunConfig({}, fallback)).toEqual({
      cli: "claude",
      model: "fallback-model",
      thinking: "fallback-effort",
    });
  });

  it("returns null cli when nothing provides one", () => {
    expect(resolveRunConfig({ agent: {}, job: {} }, {}).cli).toBeNull();
  });
});

// Hardening: when the server sends an agent block (current /next), that block
// is authoritative — including its nulls. A stale runners.json (legacy, with
// cli/model/thinking baked in) must NOT leak old values back in, or a model
// you cleared in the dashboard would silently come back. The fallback applies
// ONLY when the payload has no agent block at all (a legacy server).
describe("resolveRunConfig — agent block is authoritative", () => {
  const legacy = { cli: "gemini", model: "legacy-model", thinking: "legacy-effort" };

  it("ignores the legacy runner config entirely when an agent block is present", () => {
    const payload = { agent: { cli: "claude", model: "opus", thinking: "high" }, job: {} };
    expect(resolveRunConfig(payload, legacy)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });

  it("does not let a legacy model resurrect a deliberately-cleared agent model", () => {
    const payload = { agent: { cli: "claude", model: null, thinking: null }, job: {} };
    expect(resolveRunConfig(payload, legacy)).toEqual({
      cli: "claude",
      model: null,
      thinking: null,
    });
  });

  it("honors a per-job override over the agent default within an agent block", () => {
    const payload = {
      agent: { cli: "claude", model: "sonnet", thinking: "low" },
      job: { model: "opus", thinking: "high" },
    };
    expect(resolveRunConfig(payload, legacy)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });

  it("uses the runner-config fallback only when there is no agent block (legacy server)", () => {
    expect(resolveRunConfig({ job: {} }, legacy)).toEqual({
      cli: "gemini",
      model: "legacy-model",
      thinking: "legacy-effort",
    });
  });

  it("still applies a per-job override against a legacy server", () => {
    expect(resolveRunConfig({ job: { model: "opus" } }, legacy)).toEqual({
      cli: "gemini",
      model: "opus",
      thinking: "legacy-effort",
    });
  });
});

// The full chain, per CLI: a /next payload -> resolveRunConfig -> the provider's
// argv. This is the integration point the dashboard relies on, so assert the
// model/effort actually land in each tool's command the way that tool expects.
describe("payload -> command, all CLIs", () => {
  const CWD = "/tmp/ws";
  const PROMPT = "do it";

  it("claude: model via --model, effort via --effort", () => {
    const payload = { agent: { cli: "claude", model: "opus", thinking: "high" }, job: {} };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, "uuid", true, thinking);
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("opus");
    expect(cmd.args[cmd.args.indexOf("--effort") + 1]).toBe("high");
  });

  it("codex: model via -m, effort via -c model_reasoning_effort", () => {
    const payload = { agent: { cli: "codex", model: "gpt-5", thinking: "medium" }, job: {} };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, null, true, thinking);
    expect(cmd.args[cmd.args.indexOf("-m") + 1]).toBe("gpt-5");
    expect(cmd.args).toContain("model_reasoning_effort=medium");
  });

  it("gemini: model via -m, effort dropped (controlled by model)", () => {
    const payload = {
      agent: { cli: "gemini", model: "gemini-2.5-pro", thinking: "high" },
      job: {},
    };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, null, true, thinking);
    expect(cmd.args[cmd.args.indexOf("-m") + 1]).toBe("gemini-2.5-pro");
    expect(cmd.args).not.toContain("--thinking");
    expect(cmd.args).not.toContain("--effort");
  });

  it("job override flows through to the command (opus beats sonnet for claude)", () => {
    const payload = {
      agent: { cli: "claude", model: "sonnet", thinking: "low" },
      job: { model: "opus", thinking: "high" },
    };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, "uuid", true, thinking);
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("opus");
    expect(cmd.args[cmd.args.indexOf("--effort") + 1]).toBe("high");
  });
});
