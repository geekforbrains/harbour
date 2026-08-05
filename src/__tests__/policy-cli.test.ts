import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  checkAgentPolicies,
  decidePolicyExit,
  formatPolicyLines,
  formatPolicySummary,
  listAgentRows,
  normalizePermissions,
  parsePolicyArgs,
  runPolicyCheck,
  summarizePolicyResults,
} from "../../bin/lib/policy-cli.mjs";

// `harbour policy check` is the pre-deploy gate for the enforced-by-default
// cutover: it must resolve every agent exactly the way the runner will, print
// one legible line per agent, and exit 1 iff any enforced agent would be
// refused. The DB and resolveAgentPolicy are injected here — these tests never
// touch ~/.harbour or spawn a CLI.

type Row = {
  name: string;
  slug: string;
  cli: string | null;
  permissions: string | null;
  project_slug: string;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    name: "Dev Agent",
    slug: "dev-agent",
    cli: "claude",
    permissions: "enforced",
    project_slug: "website",
    ...overrides,
  };
}

const okEnforced = { ok: true as const, mode: "enforced" as const };
const okUnrestricted = { ok: true as const, mode: "unrestricted" as const };

describe("parsePolicyArgs", () => {
  it("parses no flags", () => {
    expect(parsePolicyArgs([])).toEqual({ ok: true, agent: null });
  });

  it("parses --agent <slug> and --agent=<slug>", () => {
    expect(parsePolicyArgs(["--agent", "dev-agent"])).toEqual({ ok: true, agent: "dev-agent" });
    expect(parsePolicyArgs(["--agent=dev-agent"])).toEqual({ ok: true, agent: "dev-agent" });
  });

  it("rejects --agent without a value", () => {
    expect(parsePolicyArgs(["--agent"]).ok).toBe(false);
    expect(parsePolicyArgs(["--agent", "--force"]).ok).toBe(false);
    expect(parsePolicyArgs(["--agent="]).ok).toBe(false);
  });

  it("rejects unknown arguments", () => {
    const parsed = parsePolicyArgs(["--bogus"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--bogus");
  });
});

describe("normalizePermissions", () => {
  it("passes exactly 'unrestricted' through", () => {
    expect(normalizePermissions("unrestricted")).toBe("unrestricted");
  });

  it("fails closed on anything else", () => {
    expect(normalizePermissions("enforced")).toBe("enforced");
    expect(normalizePermissions(null)).toBe("enforced");
    expect(normalizePermissions(undefined)).toBe("enforced");
    expect(normalizePermissions("UNRESTRICTED")).toBe("enforced");
    expect(normalizePermissions("junk")).toBe("enforced");
  });
});

describe("checkAgentPolicies", () => {
  it("resolves each agent against its workspace dir with normalized permissions", () => {
    const resolveAgentPolicy = vi.fn().mockReturnValue(okEnforced);
    checkAgentPolicies([row({ permissions: null })], {
      resolveAgentPolicy,
      harbourDir: "/hb",
    });
    expect(resolveAgentPolicy).toHaveBeenCalledWith({
      cli: "claude",
      workingDir: path.join("/hb", "workspaces", "website", "dev-agent"),
      permissions: "enforced",
    });
  });

  it("maps resolved, unrestricted, and failing agents", () => {
    const resolveAgentPolicy = vi
      .fn()
      .mockReturnValueOnce(okEnforced)
      .mockReturnValueOnce(okUnrestricted)
      .mockReturnValueOnce({ ok: false, reason: "missing .claude/settings.json" });
    const results = checkAgentPolicies(
      [
        row(),
        row({ slug: "social", permissions: "unrestricted" }),
        row({ slug: "ops", project_slug: "infra" }),
      ],
      { resolveAgentPolicy, harbourDir: "/hb" },
    );
    expect(results[0]).toMatchObject({ ok: true, mode: "enforced", reason: null });
    expect(results[1]).toMatchObject({ ok: true, mode: "unrestricted" });
    expect(results[2]).toMatchObject({
      ok: false,
      mode: "enforced",
      reason: "missing .claude/settings.json",
      project: "infra",
      slug: "ops",
    });
  });
});

describe("formatPolicyLines", () => {
  it("prints one aligned line per agent: id, cli, mode, OK or the reason", () => {
    const lines = formatPolicyLines([
      {
        project: "website",
        slug: "dev-agent",
        cli: "claude",
        mode: "enforced",
        ok: true,
        reason: null,
      },
      {
        project: "website",
        slug: "ops",
        cli: "codex",
        mode: "unrestricted",
        ok: true,
        reason: null,
      },
      {
        project: "infra",
        slug: "deploy",
        cli: null,
        mode: "enforced",
        ok: false,
        reason: "no CLI configured",
      },
    ]);
    expect(lines[0]).toMatch(/website\/dev-agent\s+claude\s+enforced\s+OK$/);
    expect(lines[1]).toMatch(/website\/ops\s+codex\s+unrestricted\s+OK$/);
    expect(lines[2]).toMatch(/infra\/deploy\s+-\s+enforced\s+FAIL {2}no CLI configured$/);
    // Columns line up: every OK/FAIL marker starts at the same offset.
    const markers = lines.map((l: string) => l.search(/OK|FAIL/));
    expect(new Set(markers).size).toBe(1);
  });
});

describe("summary and exit code", () => {
  const results = [
    { project: "a", slug: "x", cli: "claude", mode: "enforced", ok: true, reason: null },
    { project: "a", slug: "y", cli: "codex", mode: "unrestricted", ok: true, reason: null },
    { project: "b", slug: "z", cli: "codex", mode: "enforced", ok: false, reason: "bad" },
  ];

  it("counts ok / unrestricted / failing separately", () => {
    expect(summarizePolicyResults(results)).toEqual({ ok: 1, unrestricted: 1, failing: 1 });
    expect(formatPolicySummary({ ok: 1, unrestricted: 1, failing: 1 })).toBe(
      "1 ok, 1 unrestricted, 1 failing",
    );
  });

  it("exits 1 iff any agent fails to resolve", () => {
    expect(decidePolicyExit(results)).toBe(1);
    expect(decidePolicyExit(results.slice(0, 2))).toBe(0); // unrestricted counts as resolved
    expect(decidePolicyExit([])).toBe(0);
  });
});

describe("listAgentRows", () => {
  function seededDb(withPermissions: boolean): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        cli TEXT${withPermissions ? ",\n        permissions TEXT NOT NULL DEFAULT 'enforced'" : ""}
      );
    `);
    db.prepare(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'Website', 'website')`).run();
    db.prepare(
      `INSERT INTO agents (id, project_id, name, slug, cli) VALUES ('a1', 'p1', 'Dev', 'dev', 'claude')`,
    ).run();
    return db;
  }

  it("joins agents to their project slug and includes permissions", () => {
    const db = seededDb(true);
    db.prepare(`UPDATE agents SET permissions = 'unrestricted' WHERE id = 'a1'`).run();
    expect(listAgentRows(db)).toEqual([
      {
        name: "Dev",
        slug: "dev",
        cli: "claude",
        permissions: "unrestricted",
        project_slug: "website",
      },
    ]);
  });

  it("falls back to 'enforced' when the permissions column predates the upgrade", () => {
    const db = seededDb(false);
    expect(listAgentRows(db)).toEqual([
      { name: "Dev", slug: "dev", cli: "claude", permissions: "enforced", project_slug: "website" },
    ]);
  });

  it("returns no rows when the agents table doesn't exist yet", () => {
    const db = new Database(":memory:");
    expect(listAgentRows(db)).toEqual([]);
  });
});

describe("runPolicyCheck", () => {
  function deps(rows: Row[], resolveAgentPolicy = vi.fn().mockReturnValue(okEnforced)) {
    return {
      loadAgents: () => rows,
      resolveAgentPolicy,
      harbourDir: "/hb",
      log: vi.fn(),
      error: vi.fn(),
    };
  }

  it("returns 0 and prints a summary when every agent resolves", async () => {
    const d = deps([row(), row({ slug: "social", permissions: "unrestricted" })]);
    d.resolveAgentPolicy.mockReturnValueOnce(okEnforced).mockReturnValueOnce(okUnrestricted);
    expect(await runPolicyCheck([], d)).toBe(0);
    const output = d.log.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("1 ok, 1 unrestricted, 0 failing");
  });

  it("returns 1 when any enforced agent fails to resolve", async () => {
    const d = deps(
      [row(), row({ slug: "ops" })],
      vi
        .fn()
        .mockReturnValueOnce(okEnforced)
        .mockReturnValueOnce({ ok: false, reason: "missing .codex/config.toml" }),
    );
    expect(await runPolicyCheck([], d)).toBe(1);
    const output = d.log.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("missing .codex/config.toml");
    expect(output).toContain("1 ok, 0 unrestricted, 1 failing");
  });

  it("checks a single agent with --agent, matching slug or project/slug", async () => {
    const rows = [row(), row({ slug: "ops", project_slug: "infra" })];
    const d = deps(rows);
    expect(await runPolicyCheck(["--agent", "ops"], d)).toBe(0);
    expect(d.resolveAgentPolicy).toHaveBeenCalledTimes(1);
    expect(d.resolveAgentPolicy.mock.calls[0][0].workingDir).toContain(path.join("infra", "ops"));

    const qualified = deps(rows);
    expect(await runPolicyCheck(["--agent", "website/dev-agent"], qualified)).toBe(0);
    expect(qualified.resolveAgentPolicy).toHaveBeenCalledTimes(1);
  });

  it("returns 1 when --agent matches nothing", async () => {
    const d = deps([row()]);
    expect(await runPolicyCheck(["--agent", "nope"], d)).toBe(1);
    expect(d.error).toHaveBeenCalled();
  });

  it("returns 1 on bad arguments without touching the DB", async () => {
    const loadAgents = vi.fn();
    const d = { ...deps([]), loadAgents };
    expect(await runPolicyCheck(["--bogus"], d)).toBe(1);
    expect(loadAgents).not.toHaveBeenCalled();
  });

  it("returns 0 when there are no agents at all", async () => {
    const d = deps([]);
    expect(await runPolicyCheck([], d)).toBe(0);
    expect(d.resolveAgentPolicy).not.toHaveBeenCalled();
  });
});
