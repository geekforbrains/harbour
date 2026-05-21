import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../");
const fixturesDir = path.join(
  root,
  "AGENT RESEARCH/agentops/registry/agents/borg-api-key-provisioner/fixtures",
);

const allowedProviders = new Set([
  "google-ai-studio",
  "openrouter",
  "github-models",
  "cerebras",
  "groq",
  "mistral",
  "cloudflare",
  "zai",
]);

const allowedEnvByProvider: Record<string, string[]> = {
  "google-ai-studio": ["GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "github-models": ["GITHUB_MODELS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cloudflare: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  zai: ["ZAI_API_KEY"],
};

describe("provider provisioning browser fixtures", () => {
  const files = fs.readdirSync(fixturesDir).filter(file => file.endsWith(".json"));

  it("has mock fixtures for success and human-gate browser states", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    const scenarios = files.map(file => JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8")).scenario);
    expect(scenarios).toContain("key-created");
    expect(scenarios).toContain("management-api-key-created");
    expect(scenarios).toContain("mfa-required");
    expect(scenarios).toContain("billing-required");
    expect(scenarios).toContain("captcha-required");
  });

  it.each(files)("%s uses canonical providers, env names, and safe outcomes", file => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8"));
    expect(allowedProviders.has(fixture.provider)).toBe(true);
    expect(Array.isArray(fixture.canonical_env)).toBe(true);
    expect(fixture.canonical_env).toEqual(allowedEnvByProvider[fixture.provider]);
    expect(["openclaw", "api-first"]).toContain(fixture.browser_runtime);
    expect(Array.isArray(fixture.steps)).toBe(true);
    expect(fixture.steps.length).toBeGreaterThan(0);

    if (fixture.expected.status === "stored") {
      expect(fixture.expected.no_activity_secret_values).toBe(true);
      expect(fixture.expected.verification).toBeTruthy();
      expect(fixture.steps.some((step: any) => step.action === "capture_once")).toBe(true);
    } else {
      expect(fixture.expected.status).toBe("waiting");
      expect(["captcha", "mfa", "billing", "email-verification", "terms", "missing-info"]).toContain(fixture.expected.human_gate);
      expect(fixture.expected.store_secret).toBe(false);
    }
  });
});
