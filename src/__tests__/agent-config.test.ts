import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { resolveAgentPolicy } from "../../bin/lib/policy.mjs";
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
  it("includes the agent's cli/model/thinking/eager/permissions", () => {
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
      permissions: "enforced",
    });
  });

  it("carries an explicit unrestricted opt-out to the runner", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Yolo", undefined, {
      cli: "claude",
      permissions: "unrestricted",
    });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    const payload = buildRunPayload(createRun(job.id, agent.id)!.id)!;
    expect(payload.agent?.permissions).toBe("unrestricted");
  });

  it("reflects a dashboard permissions change on the next run", () => {
    const project = createProject("Website")!;
    const agent = createAgent(project.id, "Dev", undefined, { cli: "claude" });
    const job = createJob(project.id, agent.id, { name: "Build", schedule: '{"every":60}' })!;
    expect(buildRunPayload(createRun(job.id, agent.id)!.id)!.agent?.permissions).toBe("enforced");

    getDb().prepare(`UPDATE agents SET permissions = 'unrestricted' WHERE id = ?`).run(agent.id);

    expect(buildRunPayload(createRun(job.id, agent.id)!.id)!.agent?.permissions).toBe(
      "unrestricted",
    );
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
      permissions: "enforced",
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
      permissions: "enforced",
    });
  });

  it("returns null cli when nothing provides one", () => {
    expect(resolveRunConfig({ agent: {}, job: {} }).cli).toBeNull();
  });
});

// The permissions field is the security-relevant one: it decides whether the
// run gets the CLI's permission bypass. Its defaulting direction is the whole
// property — anything that isn't exactly "unrestricted" must come out
// "enforced", so a stale server, a typo, or a missing field can never produce
// a fleet of unrestricted agents.
describe("resolveRunConfig — permissions default fail-closed", () => {
  it("passes through an explicit unrestricted opt-out", () => {
    const payload = { agent: { cli: "claude", permissions: "unrestricted" }, job: {} };
    expect(resolveRunConfig(payload).permissions).toBe("unrestricted");
  });

  it("defaults to enforced when the agent block omits permissions (older server)", () => {
    expect(resolveRunConfig({ agent: { cli: "claude" }, job: {} }).permissions).toBe("enforced");
  });

  it("normalizes junk, casing, and wrong types to enforced", () => {
    for (const value of ["Unrestricted", "UNRESTRICTED", "yolo", "", null, 1, true, {}]) {
      const payload = { agent: { cli: "claude", permissions: value }, job: {} };
      expect(resolveRunConfig(payload).permissions, JSON.stringify(value)).toBe("enforced");
    }
  });

  it("ignores a job-level permissions field — permissions belong to the agent", () => {
    const payload = {
      agent: { cli: "claude", permissions: "enforced" },
      job: { permissions: "unrestricted" },
    };
    expect(resolveRunConfig(payload).permissions).toBe("enforced");
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
      permissions: "enforced",
    });
  });

  it("does not resurrect a deliberately-cleared agent model", () => {
    const payload = { agent: { cli: "claude", model: null, thinking: null }, job: {} };
    expect(resolveRunConfig(payload)).toEqual({
      cli: "claude",
      model: null,
      thinking: null,
      permissions: "enforced",
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
      permissions: "enforced",
    });
  });
});

// The full chain, per CLI: a claim payload -> resolveRunConfig -> the provider's
// argv. This is the integration point the dashboard relies on, so assert the
// model/effort actually land in each tool's command the way that tool expects.
describe("payload -> command, all CLIs", () => {
  const CWD = "/tmp/ws";
  const PROMPT = "do it";
  // These cases are about model/effort plumbing, so they run with the simplest
  // policy. Policy-specific argv is covered in providers.test.ts, and the
  // payload → policy → argv chain below.
  const BYPASS = { ok: true, mode: "unrestricted" };

  it("claude: model via --model, effort via --effort", () => {
    const payload = { agent: { cli: "claude", model: "opus", thinking: "high" }, job: {} };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, "uuid", true, thinking, BYPASS);
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("opus");
    expect(cmd.args[cmd.args.indexOf("--effort") + 1]).toBe("high");
  });

  it("codex: model via -m, effort via -c model_reasoning_effort", () => {
    const payload = { agent: { cli: "codex", model: "gpt-5", thinking: "medium" }, job: {} };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, null, true, thinking, BYPASS);
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
    const cmd = getProvider(cli).buildCommand(
      PROMPT,
      model,
      CWD,
      "uuid",
      true,
      sanitized.thinking,
      BYPASS,
    );
    expect(cmd.args).not.toContain("--effort");
    expect(cmd.args).not.toContain("off");
  });

  it("job override flows through to the command (opus beats sonnet for claude)", () => {
    const payload = {
      agent: { cli: "claude", model: "sonnet", thinking: "low" },
      job: { model: "opus", thinking: "high" },
    };
    const { cli, model, thinking } = resolveRunConfig(payload);
    const cmd = getProvider(cli).buildCommand(PROMPT, model, CWD, "uuid", true, thinking, BYPASS);
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("opus");
    expect(cmd.args[cmd.args.indexOf("--effort") + 1]).toBe("high");
  });
});

// The full permission chain, end to end in one place: what the dashboard stored
// -> the claim payload -> resolveRunConfig -> resolveAgentPolicy -> the argv the
// CLI is actually spawned with. This is the contract that decides whether a
// bypass flag reaches a real subprocess, so assert it against a real workspace
// on disk rather than a hand-built policy object.
describe("payload -> policy -> command", () => {
  const PROMPT = "do it";
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-perm-chain-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("an unrestricted claude agent gets the bypass flag", () => {
    const payload = { agent: { cli: "claude", permissions: "unrestricted" }, job: {} };
    const { cli, permissions } = resolveRunConfig(payload);
    const policy = resolveAgentPolicy({ cli, workingDir: ws, permissions });
    const cmd = getProvider(cli).buildCommand(PROMPT, null, ws, "uuid", true, null, policy);
    expect(cmd.args).toContain("--dangerously-skip-permissions");
  });

  it("an enforced claude agent with a policy file gets --settings and no bypass", () => {
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "dontAsk", allow: ["Bash(curl *)"] } }),
    );
    const payload = { agent: { cli: "claude", permissions: "enforced" }, job: {} };
    const { cli, permissions } = resolveRunConfig(payload);
    const policy = resolveAgentPolicy({ cli, workingDir: ws, permissions });
    expect(policy.ok).toBe(true);
    const cmd = getProvider(cli).buildCommand(PROMPT, null, ws, "uuid", true, null, policy);
    expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    expect(cmd.args).toContain("--settings");
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("an enforced agent with NO policy file never reaches a command at all", () => {
    const payload = { agent: { cli: "claude", permissions: "enforced" }, job: {} };
    const { cli, permissions } = resolveRunConfig(payload);
    const policy = resolveAgentPolicy({ cli, workingDir: ws, permissions });
    expect(policy.ok).toBe(false);
    // The runner returns before building a command; if a caller tried anyway,
    // the provider refuses rather than falling back to bypass.
    expect(() =>
      getProvider(cli).buildCommand(PROMPT, null, ws, "uuid", true, null, policy),
    ).toThrow(/policy/i);
  });

  it("an enforced codex agent gets its sandbox mode, never the bypass flag", () => {
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".codex", "config.toml"),
      'sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = true\n',
    );
    const payload = { agent: { cli: "codex", permissions: "enforced" }, job: {} };
    const { cli, permissions } = resolveRunConfig(payload);
    const policy = resolveAgentPolicy({ cli, workingDir: ws, permissions });
    expect(policy.ok).toBe(true);
    const cmd = getProvider(cli).buildCommand(PROMPT, null, ws, null, true, null, policy);
    expect(cmd.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd.args[cmd.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(cmd.args).toContain("--skip-git-repo-check");
  });
});
