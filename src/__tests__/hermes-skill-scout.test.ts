import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadScout() {
  const script = path.join(process.cwd(), "..", "AGENT RESEARCH/agentops/scripts/hermes-skill-scout.mjs");
  return import(pathToFileURL(script).href);
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(data: string, status = 200) {
  return new Response(data, { status, headers: { "Content-Type": "text/plain" } });
}

function repoMeta(name: string, overrides: Record<string, unknown> = {}) {
  return {
    full_name: `owner/${name}`,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    archived: false,
    fork: false,
    pushed_at: new Date().toISOString(),
    stargazers_count: 42,
    topics: ["hermes", "skills"],
    license: { spdx_id: "MIT" },
    ...overrides,
  };
}

function tree(paths: string[]) {
  return { tree: paths.map(filePath => ({ path: filePath, type: "blob" })) };
}

describe("Hermes skill scout", () => {
  it("parses Skills Hub counts and awesome-list maturity rows", async () => {
    const scout = await loadScout();
    expect(scout.parseSkillsHubStats("Discover, search, and install from 691 skills across 4 registries 89 Built-in 81 Optional 521 Community 18 Categories")).toEqual({
      total: 691,
      builtIn: 89,
      optional: 81,
      community: 521,
      categories: 18,
    });
    expect(scout.parseSkillsHubStats('Discover, search, and install from<!-- --> <strong>691</strong> skills across <!-- -->4<!-- --> registries <span>89</span><span>Built-in</span><span>81</span><span>Optional</span><span>521</span><span>Community</span><span>18</span><span>Categories</span>')).toEqual({
      total: 691,
      builtIn: 89,
      optional: 81,
      community: 521,
      categories: 18,
    });

    const candidates = scout.parseAwesomeMarkdown(`
## Community Skills
- **[production]** [prod-skill](https://github.com/owner/prod-skill) by [Owner](https://github.com/owner) - Production skill pack.
- **[beta]** [beta-skill](https://github.com/owner/beta-skill/tree/main/skills/beta) - Beta skill pack.
`);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      maturity: "production",
      name: "prod-skill",
      repoOwner: "owner",
      repoName: "prod-skill",
      section: "Community Skills",
    });
    expect(candidates[1]).toMatchObject({
      maturity: "beta",
      repoPath: "skills/beta",
    });
  });

  it("decides promotion and proposal reasons deterministically", async () => {
    const scout = await loadScout();
    const official = {
      kind: "official",
      officialKind: "bundled",
      slug: "codex",
      name: "codex",
    };
    const community = {
      kind: "community",
      maturity: "production",
      repoOwner: "owner",
      repoName: "prod",
      slug: "prod",
      name: "prod",
    };

    expect(scout.decideCandidate(official, {}, new Set())).toMatchObject({ action: "promote" });
    expect(scout.decideCandidate({ ...community, maturity: "beta" }, { ok: true }, new Set())).toMatchObject({ action: "propose", reason: "maturity-beta" });
    expect(scout.decideCandidate(community, { ok: false }, new Set())).toMatchObject({ action: "propose", reason: "repo-inspection-error" });
    expect(scout.decideCandidate(community, { ok: true, repo: { archived: true } }, new Set())).toMatchObject({ action: "propose", reason: "archived-repo" });
    expect(scout.decideCandidate(community, { ok: true, repo: { archived: false, licenseSpdx: "MIT" }, stale: true }, new Set())).toMatchObject({ action: "propose", reason: "stale-repo" });
    expect(scout.decideCandidate(community, { ok: true, repo: { archived: false, licenseSpdx: null }, stale: false }, new Set())).toMatchObject({ action: "propose", reason: "missing-license" });
    expect(scout.decideCandidate(community, { ok: true, repo: { archived: false, licenseSpdx: "MIT" }, stale: false, hasManifest: false }, new Set())).toMatchObject({ action: "propose", reason: "missing-skill-manifest" });
    expect(scout.decideCandidate(community, { ok: true, repo: { archived: false, licenseSpdx: "MIT" }, stale: false, hasManifest: true }, new Set())).toMatchObject({ action: "promote" });
  });

  it("loads official root, two-level, and nested SKILL.md files", async () => {
    const scout = await loadScout();
    vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      const href = String(url);
      if (href.includes("/git/trees/main")) {
        return jsonResponse(tree([
          "skills/dogfood/SKILL.md",
          "skills/autonomous-ai-agents/codex/SKILL.md",
          "optional-skills/mlops/training/axolotl/SKILL.md",
        ]));
      }
      if (href.endsWith("/skills/dogfood/SKILL.md")) {
        return textResponse('---\nname: dogfood\ndescription: "Dogfood Hermes."\n---\n# Dogfood\n');
      }
      if (href.endsWith("/skills/autonomous-ai-agents/codex/SKILL.md")) {
        return textResponse('---\nname: codex\ndescription: "Delegate coding to Codex CLI."\n---\n# Codex\n');
      }
      if (href.endsWith("/optional-skills/mlops/training/axolotl/SKILL.md")) {
        return textResponse('---\nname: axolotl\ndescription: "Train with Axolotl."\n---\n# Axolotl\n');
      }
      if (href === "https://hermes-agent.nousresearch.com/docs/skills/") {
        return textResponse("Discover, search, and install from 3 skills across 1 registries 2 Built-in 1 Optional 0 Community 2 Categories");
      }
      return textResponse("not found", 404);
    });

    const candidates = await scout.loadOfficialCandidates();
    expect(candidates.map((candidate: any) => [candidate.name, candidate.category, candidate.slug, candidate.officialKind])).toEqual([
      ["axolotl", "mlops", "axolotl", "optional"],
      ["codex", "autonomous-ai-agents", "codex", "bundled"],
      ["dogfood", "dogfood", "dogfood", "bundled"],
    ]);
  });

  it("runs mocked official and awesome scout loop with promote, proposal, duplicate, and error cases", async () => {
    const scout = await loadScout();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-scout-"));
    const registryPath = path.join(tmp, "registry.yaml");
    const officialRoot = path.join(tmp, "hermes-official");
    const communityRoot = path.join(tmp, "hermes-community");
    const statePath = path.join(tmp, "state.json");
    const proposals: { name: string; reason: string }[] = [];
    fs.writeFileSync(registryPath, [
      'version: "test"',
      "skills:",
      "  - id: hermes-community-dup-dup-duplicate-skill",
      '    name: "Duplicate Skill"',
      "    status: active",
      "    agent_compatibility: [hermes]",
      "brand_kits:",
      "",
    ].join("\n"));

    const officialTree = tree([
      "skills/autonomous-ai-agents/codex/SKILL.md",
      "optional-skills/security/sherlock/SKILL.md",
      "skills/apple/DESCRIPTION.md",
    ]);
    const awesomeReadme = `
## Community Skills
- **[production]** [Prod Skill](https://github.com/owner/prod) - Production skill pack.
- **[beta]** [Beta Skill](https://github.com/owner/beta) - Beta skill pack.
- **[experimental]** [Experimental Skill](https://github.com/owner/experimental) - Experimental skill pack.
- **[production]** [Missing Manifest](https://github.com/owner/missing) - Missing manifest pack.
- **[production]** [Stale Skill](https://github.com/owner/stale) - Stale skill pack.
- **[production]** [Archived Skill](https://github.com/owner/archived) - Archived skill pack.
- **[production]** [No License](https://github.com/owner/no-license) - No license skill pack.
- **[production]** [Error Skill](https://github.com/owner/error) - Error skill pack.
- **[production]** [Duplicate Skill](https://github.com/dup/dup) - Duplicate skill pack.
`;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      const href = String(url);
      if (href === "https://hermes-agent.nousresearch.com/docs/skills/") {
        return textResponse("Discover, search, and install from 691 skills across 4 registries 89 Built-in 81 Optional 521 Community 18 Categories");
      }
      if (href === "https://api.github.com/repos/NousResearch/hermes-agent/git/trees/main?recursive=1") {
        return jsonResponse(officialTree);
      }
      if (href.endsWith("/skills/autonomous-ai-agents/codex/SKILL.md")) {
        return textResponse('---\nname: codex\ndescription: "Delegate coding to Codex CLI."\nversion: 1.0.0\nauthor: Hermes Agent\nlicense: MIT\nplatforms: [linux, macos]\n---\n# Codex\n');
      }
      if (href.endsWith("/optional-skills/security/sherlock/SKILL.md")) {
        return textResponse('---\nname: sherlock\ndescription: "Find social media accounts."\nversion: 1.0.0\nauthor: Hermes Agent\nlicense: MIT\nplatforms: [linux]\n---\n# Sherlock\n');
      }
      if (href === "https://raw.githubusercontent.com/0xNyk/awesome-hermes-agent/main/README.md") {
        return textResponse(awesomeReadme);
      }

      const repoMatch = href.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch) {
        const repo = repoMatch[2];
        if (repo === "error") return textResponse("nope", 500);
        if (repo === "archived") return jsonResponse(repoMeta(repo, { archived: true }));
        if (repo === "stale") return jsonResponse(repoMeta(repo, { pushed_at: "2000-01-01T00:00:00Z" }));
        if (repo === "no-license") return jsonResponse(repoMeta(repo, { license: null }));
        return jsonResponse(repoMeta(repo));
      }

      const treeMatch = href.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/trees\/main\?recursive=1$/);
      if (treeMatch) {
        const repo = treeMatch[2];
        if (repo === "missing") return jsonResponse(tree(["README.md"]));
        return jsonResponse(tree([`skills/${repo}/SKILL.md`, "README.md"]));
      }

      return textResponse("not found", 404);
    });

    const summary = await scout.runScout({
      source: "all",
      limit: 20,
      registryPath,
      officialRoot,
      communityRoot,
      statePath,
      proposalWriter: (candidate: any, _inspection: any, reason: string) => {
        proposals.push({ name: candidate.name, reason });
      },
    });

    const registry = fs.readFileSync(registryPath, "utf-8");
    expect(summary).toEqual({ scanned: 10, promoted: 3, proposed: 7, skipped: 1, errors: 1 });
    expect(registry).toContain("id: hermes-official-bundled-codex");
    expect(registry).toContain("id: hermes-official-optional-sherlock");
    expect(registry).toContain("id: hermes-community-owner-prod-prod-skill");
    expect(registry).toContain("agent_compatibility: [hermes]");
    expect(fs.existsSync(path.join(officialRoot, "bundled-codex", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(officialRoot, "optional-sherlock", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(communityRoot, "owner-prod-prod-skill", "SKILL.md"))).toBe(true);
    expect(proposals).toEqual([
      { name: "Beta Skill", reason: "maturity-beta" },
      { name: "Experimental Skill", reason: "maturity-experimental" },
      { name: "Missing Manifest", reason: "missing-skill-manifest" },
      { name: "Stale Skill", reason: "stale-repo" },
      { name: "Archived Skill", reason: "archived-repo" },
      { name: "No License", reason: "missing-license" },
      { name: "Error Skill", reason: "repo-inspection-error" },
    ]);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("/repos/dup/dup"))).toHaveLength(0);
  });
});
