import { beforeEach, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";
import {
  createAgent,
  createJob,
  getAgentNextRun,
  resolveSkillsForAgent,
  setAgentSkillOverrides,
  updateJob,
  upsertSkill,
} from "@/lib/db/queries";
import { getToolkitLibraries, RUNTIME_SECURITY } from "@/lib/toolkit-libraries";

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

function seedCompatibilitySkills() {
  upsertSkill({
    id: "openclaw-only",
    name: "OpenCLaw Only",
    scope: "global",
    status: "active",
    agent_compatibility: ["openclaw"],
  } as any);
  upsertSkill({
    id: "hermes-only",
    name: "Hermes Only",
    scope: "global",
    status: "active",
    agent_compatibility: ["hermes"],
  } as any);
  upsertSkill({
    id: "both-agents",
    name: "Both Agents",
    scope: "global",
    status: "active",
    agent_compatibility: ["openclaw", "hermes"],
  } as any);
}

describe("skill agent compatibility", () => {
  it("filters automatically resolved skills by OpenCLaw and Hermes compatibility", () => {
    seedCompatibilitySkills();
    const openclaw = createAgent("openclaw-bot", undefined, { type: "harbour", cli: "openclaw" });
    const hermes = createAgent("hermes-bot", undefined, { type: "harbour", cli: "hermes" });

    expect(resolveSkillsForAgent(openclaw.id).map(skill => skill.id).sort()).toEqual([
      "both-agents",
      "openclaw-only",
    ]);
    expect(resolveSkillsForAgent(hermes.id).map(skill => skill.id).sort()).toEqual([
      "both-agents",
      "hermes-only",
    ]);
  });

  it("keeps explicit include overrides even when the skill is not normally compatible", () => {
    seedCompatibilitySkills();
    const openclaw = createAgent("openclaw-bot", undefined, { type: "harbour", cli: "openclaw" });
    setAgentSkillOverrides(openclaw.id, [{ skillId: "hermes-only", mode: "include" }]);

    expect(resolveSkillsForAgent(openclaw.id).map(skill => skill.id).sort()).toEqual([
      "both-agents",
      "hermes-only",
      "openclaw-only",
    ]);
  });

  it("decodes legacy inline YAML compatibility values from existing rows", () => {
    seedCompatibilitySkills();
    getDb().prepare(`UPDATE skills SET agent_compatibility = ? WHERE id = ?`).run("[hermes]", "hermes-only");
    const openclaw = createAgent("openclaw-bot", undefined, { type: "harbour", cli: "openclaw" });
    const hermes = createAgent("hermes-bot", undefined, { type: "harbour", cli: "hermes" });

    expect(resolveSkillsForAgent(openclaw.id).map(skill => skill.id)).not.toContain("hermes-only");
    expect(resolveSkillsForAgent(hermes.id).map(skill => skill.id)).toContain("hermes-only");
  });

  it("exposes compatibility metadata in toolkit library packets", () => {
    const openclawToolkit = getToolkitLibraries({ agentCli: "openclaw" });
    const skillEntries = openclawToolkit.libraries.find(library => library.id === "skills")?.entries || [];

    expect(skillEntries.map(entry => entry.id)).toContain("provider-api-key-provisioning");
    expect(skillEntries.map(entry => entry.id)).not.toContain("x-api-ingestion");
    expect(skillEntries.find(entry => entry.id === "find-skills")?.agent_compatibility).toEqual([
      "openclaw",
      "hermes",
    ]);
  });

  it("attaches only compatible toolkit entries to OpenCLaw run payloads", () => {
    seedCompatibilitySkills();
    const openclaw = createAgent("openclaw-bot", undefined, { type: "harbour", cli: "openclaw" });
    const job = createJob(openclaw.id, { name: "Compatibility", schedule: "{\"every\":1}" });
    updateJob(job!.id, { nextRunAt: Math.floor(Date.now() / 1000) - 60 });

    const payload = getAgentNextRun(openclaw.id) as any;
    const toolkitSkills = payload.toolkit_libraries.libraries.find((library: any) => library.id === "skills").entries;
    const payloadSkills = payload.skills.map((skill: any) => skill.id);

    expect(toolkitSkills.map((entry: any) => entry.id)).toContain("provider-api-key-provisioning");
    expect(toolkitSkills.map((entry: any) => entry.id)).not.toContain("x-api-ingestion");
    expect(payload.runtime_security).toEqual(RUNTIME_SECURITY);
    expect(payloadSkills).toContain("openclaw-only");
    expect(payloadSkills).not.toContain("hermes-only");

    const cols = getDb().prepare(`PRAGMA table_info(skills)`).all() as { name: string }[];
    expect(cols.map(col => col.name)).toContain("agent_compatibility");
  }, 20000);
});
