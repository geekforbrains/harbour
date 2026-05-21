import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadScout() {
  const script = path.join(process.cwd(), "..", "AGENT RESEARCH/agentops/scripts/openclaw-skill-scout.mjs");
  return import(pathToFileURL(script).href);
}

describe("OpenCLaw skill scout", () => {
  it("parses VoltAgent category markdown and transforms ClawSkills URLs into ClawHub scanner URLs", async () => {
    const scout = await loadScout();
    const candidates = scout.parseCategoryMarkdown(`
- [agent-commons](https://clawskills.sh/skills/zanblayde-agent-commons) - Consult, commit, extend, and challenge reasoning chains.
- [external](https://example.com/not-a-skill) - Ignore this row.
`, "git-and-github.md");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "agent-commons",
      slug: "zanblayde-agent-commons",
      category: "git-and-github",
      description: "Consult, commit, extend, and challenge reasoning chains.",
    });
    expect(scout.toClawHubUrl(candidates[0])).toEqual({
      ok: true,
      url: "https://clawhub.ai/zanblayde/agent-commons",
    });
  });

  it("promotes LOW and MEDIUM scanner results while holding HIGH and invalid transforms as proposals", async () => {
    const scout = await loadScout();
    const candidate = {
      name: "agent-commons",
      slug: "zanblayde-agent-commons",
      category: "git-and-github",
      description: "Consult reasoning chains.",
      sourceUrl: "https://clawskills.sh/skills/zanblayde-agent-commons",
    };

    expect(scout.decideCandidate(candidate, { severity: "LOW" }, new Set())).toMatchObject({
      action: "promote",
      skillId: "openclaw-community-zanblayde-agent-commons",
    });
    expect(scout.decideCandidate(candidate, { severity: "MEDIUM" }, new Set())).toMatchObject({
      action: "promote",
    });
    expect(scout.decideCandidate(candidate, { severity: "HIGH" }, new Set())).toMatchObject({
      action: "propose",
      reason: "scanner-severity-high",
    });
    expect(scout.decideCandidate({ ...candidate, slug: "badslug" }, null, new Set())).toMatchObject({
      action: "propose",
      reason: "invalid-clawhub-url",
    });
  });

  it("skips duplicate promoted skills and builds OpenCLaw-only registry metadata", async () => {
    const scout = await loadScout();
    const candidate = {
      name: "agent-commons",
      slug: "zanblayde-agent-commons",
      category: "git-and-github",
      description: "Consult reasoning chains.",
      sourceUrl: "https://clawskills.sh/skills/zanblayde-agent-commons",
    };
    const scan = { severity: "MEDIUM", reasons: ["Uses a third-party API."], author: "ZanBlayde", displayName: "Agent Commons" };

    expect(scout.decideCandidate(candidate, scan, new Set(["openclaw-community-zanblayde-agent-commons"]))).toMatchObject({
      action: "skip",
      reason: "already-registered",
    });

    const entry = scout.buildRegistryEntry(candidate, scan, "/tmp/SKILL.md");
    expect(entry).toContain("id: openclaw-community-zanblayde-agent-commons");
    expect(entry).toContain("agent_compatibility: [openclaw]");
    expect(entry).toContain("risk_level: medium");
    expect(entry).toContain("source_agent: openclaw-skill-scout");
  });

  it("runs the mocked GitHub and scanner loop for LOW, MEDIUM, HIGH, invalid, and duplicate cases", async () => {
    const scout = await loadScout();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scout-"));
    const registryPath = path.join(tmp, "registry.yaml");
    const communityRoot = path.join(tmp, "community");
    const statePath = path.join(tmp, "state.json");
    const proposals: { name: string; reason: string; severity: string }[] = [];
    fs.writeFileSync(registryPath, [
      'version: "test"',
      "skills:",
      "  - id: openclaw-community-dup-skill",
      '    name: "Already Registered"',
      "    status: active",
      "    agent_compatibility: [openclaw]",
      "brand_kits:",
      "",
    ].join("\n"));

    const categoryMarkdown = `
- [low-tool](https://clawskills.sh/skills/alice-low-tool) - Low risk tool.
- [medium-tool](https://clawskills.sh/skills/bob-medium-tool) - Medium risk tool.
- [high-tool](https://clawskills.sh/skills/carol-high-tool) - High risk tool.
- [invalid-tool](https://clawskills.sh/skills/nosplit) - Invalid transform.
- [duplicate-tool](https://clawskills.sh/skills/dup-skill) - Duplicate tool.
`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/contents/categories")) {
        return new Response(JSON.stringify([{ type: "file", name: "git-and-github.md", download_url: "https://mock.local/git-and-github.md" }]), { status: 200 });
      }
      if (href === "https://mock.local/git-and-github.md") {
        return new Response(categoryMarkdown, { status: 200 });
      }
      if (href.includes("/api/scan/lookup")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const severity = body.skillUrl.includes("/alice/") ? "LOW"
          : body.skillUrl.includes("/bob/") ? "MEDIUM"
            : "HIGH";
        return new Response(JSON.stringify({ severity, reasons: [`${severity} fixture`], displayName: body.skillUrl }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const summary = await scout.runScout({
      categories: ["git-and-github"],
      limit: 10,
      registryPath,
      communityRoot,
      statePath,
      proposalWriter: (candidate: any, scan: any, reason: string) => {
        proposals.push({ name: candidate.name, reason, severity: scout.normalizeSeverity(scan) });
      },
    });

    const registry = fs.readFileSync(registryPath, "utf-8");
    expect(summary).toEqual({ scanned: 4, promoted: 2, proposed: 2, skipped: 1, errors: 0 });
    expect(registry).toContain("id: openclaw-community-alice-low-tool");
    expect(registry).toContain("id: openclaw-community-bob-medium-tool");
    expect(registry).not.toContain("id: openclaw-community-carol-high-tool");
    expect(registry).not.toContain("id: openclaw-community-nosplit");
    expect(fs.existsSync(path.join(communityRoot, "alice-low-tool", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(communityRoot, "bob-medium-tool", "SKILL.md"))).toBe(true);
    expect(proposals).toEqual([
      { name: "high-tool", reason: "scanner-severity-high", severity: "HIGH" },
      { name: "invalid-tool", reason: "invalid-clawhub-url", severity: "UNKNOWN" },
    ]);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("/api/scan/lookup"))).toHaveLength(3);
  });
});
