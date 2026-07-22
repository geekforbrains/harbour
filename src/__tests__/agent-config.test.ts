import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunPayload,
  createAgent,
  createJob,
  createProject,
  createRun,
  createWorkflow,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import { getProvider, resolveRunConfig, sanitizeThinking } from "../../bin/lib/providers.mjs";

// End-to-end coverage for the "harbour is the source of truth for agent config"
// model: the claim payload carries the agent's live cli/model/thinking, the
// runner resolves them (job override > agent default), and each CLI provider
// turns that into the right argv. The runner config is identity-only, so
// changing a model in the dashboard must reach the runner via the payload
// alone — these tests lock that contract for every supported CLI.

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

describe("run payload carries live agent config", () => {
  it("includes the agent's cli/model/thinking/eager", () => {
    const project = createProject("Website")!;
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
    const project = createProject("Website")!;
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
    const project = createProject("Website")!;
    const job = createWorkflow(project.id, {
      name: "WF",
      schedule: '{"every":60}',
      workflow: { runtime: "bash", content: "echo hi" },
    })!;
    const run = createRun(job.id, null)!;
    const payload = buildRunPayload(run.id)!;
    // No agent → no agent block. Workflow runs never spawn a CLI.
    expect(payload.agent).toBeUndefined();
    expect(payload.job.kind).toBe("workflow");
    expect(payload.job.command).toEqual({ runtime: "bash", content: "echo hi" });
  });
});

describe("resolveRunConfig precedence", () => {
  it("uses the live agent defaults from the payload", () => {
    const payload = { agent: { cli: "codex", model: "gpt-5", thinking: "medium" }, job: {} };
    expect(resolveRunConfig(payload)).toEqual({
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
    expect(resolveRunConfig(payload)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });

  it("returns null cli when nothing provides one", () => {
    expect(resolveRunConfig({ agent: {}, job: {} }).cli).toBeNull();
  });
});

// Hardening: the claim payload's agent block is authoritative — including its
// nulls. A model you cleared in the dashboard arrives as null and must stay
// cleared; nothing on the runner side may resurrect an old value.
describe("resolveRunConfig — agent block is authoritative", () => {
  it("resolves entirely from the agent block when one is present", () => {
    const payload = { agent: { cli: "claude", model: "opus", thinking: "high" }, job: {} };
    expect(resolveRunConfig(payload)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });

  it("does not resurrect a deliberately-cleared agent model", () => {
    const payload = { agent: { cli: "claude", model: null, thinking: null }, job: {} };
    expect(resolveRunConfig(payload)).toEqual({
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
    expect(resolveRunConfig(payload)).toEqual({
      cli: "claude",
      model: "opus",
      thinking: "high",
    });
  });
});

// The full chain, per CLI: a claim payload -> resolveRunConfig -> the provider's
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

  it("an unknown thinking level is dropped before the command, not passed as a flag (issue #39)", () => {
    // The production incident: an agent stored with thinking "off" produced
    // `--effort off`, which the claude CLI rejects — every run failed at
    // launch. The runner now sanitizes the resolved level first.
    const payload = { agent: { cli: "claude", model: "sonnet", thinking: "off" }, job: {} };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const sanitized = sanitizeThinking(cli, thinking);
    expect(sanitized).toEqual({ thinking: null, dropped: "off" });
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, "uuid", true, sanitized.thinking);
    expect(cmd.args).not.toContain("--effort");
    expect(cmd.args).not.toContain("off");
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
