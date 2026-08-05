import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentPolicy } from "../../bin/lib/policy.mjs";
import {
  parseInitArgs,
  policyTemplate,
  runPolicyInit,
  templatePath,
} from "../../bin/lib/policy-cli.mjs";

// `harbour policy init` writes the starter policy an enforced agent needs to be
// able to run at all. Its whole value is that what it writes is CORRECT — a
// scaffold that produced a policy the runner then refuses, or one that can't
// reach Harbour to report, would be worse than no scaffold. So the tests assert
// the templates against the real resolver, not against fixed strings.

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-init-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ROWS = [
  { name: "Dev", slug: "dev", cli: "claude", permissions: "enforced", project_slug: "site" },
  { name: "Ops", slug: "ops", cli: "codex", permissions: "enforced", project_slug: "site" },
];

function init(args: string[], extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const code = runPolicyInit(args, {
    loadAgents: () => ROWS,
    harbourDir: home,
    log: (m: string) => out.push(m),
    error: (m: string) => errs.push(m),
    ...extra,
  });
  return { code, out: out.join("\n"), errs: errs.join("\n") };
}

const wsFor = (project: string, slug: string) => path.join(home, "workspaces", project, slug);

describe("parseInitArgs", () => {
  it("takes a bare slug or a project-qualified one", () => {
    expect(parseInitArgs(["dev"])).toEqual({ ok: true, agent: "dev", force: false });
    expect(parseInitArgs(["site/dev"])).toEqual({ ok: true, agent: "site/dev", force: false });
  });

  it("accepts --force in either position", () => {
    expect(parseInitArgs(["dev", "--force"])).toMatchObject({ ok: true, force: true });
    expect(parseInitArgs(["--force", "dev"])).toMatchObject({ ok: true, force: true });
  });

  it("requires an agent and rejects unknown flags", () => {
    expect(parseInitArgs([]).ok).toBe(false);
    expect(parseInitArgs(["dev", "--wat"]).ok).toBe(false);
  });
});

describe("policyTemplate", () => {
  it("puts each CLI's policy at that CLI's own conventional path", () => {
    expect(templatePath("claude")).toBe(path.join(".claude", "settings.json"));
    expect(templatePath("codex")).toBe(path.join(".codex", "config.toml"));
  });

  it("grants claude the reporting command and nothing else", () => {
    const body = policyTemplate("claude") as string;
    const parsed = JSON.parse(body);
    expect(parsed.permissions.defaultMode).toBe("dontAsk");
    expect(parsed.permissions.allow).toEqual(["Bash(harbour update *)"]);
  });

  it("does not grant claude blanket curl or a blanket harbour rule", () => {
    // `Bash(curl *)` would hand over the whole internet, and `Bash(harbour *)`
    // the admin CLI (harbour user create, connect, install). The scaffold is
    // most people's only policy, so its default must be the narrow one.
    const body = policyTemplate("claude");
    expect(body).not.toContain("Bash(curl *)");
    expect(body).not.toContain("Bash(harbour *)");
  });

  it("gives codex a confining sandbox with the network its reporting needs", () => {
    const body = policyTemplate("codex");
    expect(body).toContain('sandbox_mode = "workspace-write"');
    expect(body).toContain("[sandbox_workspace_write]");
    expect(body).toContain("network_access = true");
  });

  it("returns null for a CLI Harbour cannot scaffold", () => {
    expect(policyTemplate("cursor")).toBeNull();
    expect(policyTemplate(null)).toBeNull();
  });
});

describe("the scaffolded policies actually resolve", () => {
  // The point of the command: what it writes must satisfy the same validation
  // the runner applies, or the agent is scaffolded straight into a failed run.
  it("claude's template passes resolveAgentPolicy", () => {
    init(["dev"]);
    const policy = resolveAgentPolicy({
      cli: "claude",
      workingDir: wsFor("site", "dev"),
      permissions: "enforced",
    });
    expect(policy).toMatchObject({ ok: true, mode: "enforced", permissionMode: "dontAsk" });
  });

  it("codex's template passes resolveAgentPolicy", () => {
    init(["ops"]);
    const policy = resolveAgentPolicy(
      { cli: "codex", workingDir: wsFor("site", "ops"), permissions: "enforced" },
      { checkRulesFile: () => ({ ok: true }) },
    );
    expect(policy).toMatchObject({ ok: true, mode: "enforced", sandboxMode: "workspace-write" });
  });
});

describe("runPolicyInit", () => {
  it("creates the file and its parent directory, and reports where", () => {
    const { code, out } = init(["dev"]);
    expect(code).toBe(0);
    const file = path.join(wsFor("site", "dev"), ".claude", "settings.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(out).toContain(file);
  });

  it("refuses to clobber an existing policy, pointing at --force", () => {
    init(["dev"]);
    const file = path.join(wsFor("site", "dev"), ".claude", "settings.json");
    fs.writeFileSync(file, '{"permissions":{"allow":["Bash(mine)"]}}');
    const { code, errs } = init(["dev"]);
    expect(code).toBe(1);
    expect(errs).toContain("--force");
    // The operator's file is untouched — this is the whole point of refusing.
    expect(fs.readFileSync(file, "utf-8")).toContain("Bash(mine)");
  });

  it("overwrites only when --force is given", () => {
    init(["dev"]);
    const file = path.join(wsFor("site", "dev"), ".claude", "settings.json");
    fs.writeFileSync(file, "{}");
    expect(init(["dev", "--force"]).code).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toContain("harbour update");
  });

  it("scaffolds the codex agent in codex's format, not claude's", () => {
    expect(init(["ops"]).code).toBe(0);
    expect(fs.existsSync(path.join(wsFor("site", "ops"), ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(wsFor("site", "ops"), ".claude"))).toBe(false);
  });

  it("fails on an unknown agent without creating anything", () => {
    const { code, errs } = init(["nope"]);
    expect(code).toBe(1);
    expect(errs).toContain("nope");
    expect(fs.existsSync(path.join(home, "workspaces"))).toBe(false);
  });

  it("refuses when the slug is ambiguous across projects", () => {
    const rows = [
      ...ROWS,
      { name: "Dev", slug: "dev", cli: "claude", permissions: "enforced", project_slug: "other" },
    ];
    const { code, errs } = init(["dev"], { loadAgents: () => rows });
    expect(code).toBe(1);
    expect(errs.toLowerCase()).toContain("ambiguous");
    expect(errs).toContain("site/dev");
  });

  it("scaffolds the qualified agent when the slug repeats", () => {
    const rows = [
      ...ROWS,
      { name: "Dev", slug: "dev", cli: "claude", permissions: "enforced", project_slug: "other" },
    ];
    expect(init(["other/dev"], { loadAgents: () => rows }).code).toBe(0);
    expect(fs.existsSync(path.join(wsFor("other", "dev"), ".claude", "settings.json"))).toBe(true);
  });

  it("refuses an agent whose CLI has no template", () => {
    const rows = [
      { name: "X", slug: "x", cli: null, permissions: "enforced", project_slug: "site" },
    ];
    expect(init(["x"], { loadAgents: () => rows }).code).toBe(1);
  });

  it("warns rather than errors when the agent is unrestricted (the file is inert)", () => {
    const rows = [
      { name: "Y", slug: "y", cli: "claude", permissions: "unrestricted", project_slug: "site" },
    ];
    const { code, out } = init(["y"], { loadAgents: () => rows });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("unrestricted");
  });
});
