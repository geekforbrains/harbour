import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createEnvVar,
  createJob,
  createProject,
  getDecryptedEnvVarsForJob,
  getEnvVarById,
  getEnvVarDecryptedValue,
  linkEnvVarToJob,
  updateEnvVar,
} from "@/lib/db/queries";
import { getDb, initializeSchema, resetDb, setDb } from "@/lib/db/schema";

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

const SCHEDULE = '{"every":60}';

function fixture() {
  const project = createProject("Site")!;
  const agent = createAgent(project.id, "Dev");
  const job = createJob(project.id, agent.id, { name: "J", schedule: SCHEDULE })!;
  return { project, agent, job };
}

// ---------------------------------------------------------------------------
// Name uniqueness — per project (enforced in the query layer; the schema has
// no UNIQUE constraint). Two projects may independently use the same name.
// ---------------------------------------------------------------------------

describe("env-var per-project name uniqueness", () => {
  it("rejects a duplicate name within one project", () => {
    const { project } = fixture();
    createEnvVar(project.id, "DUP", "a");
    expect(() => createEnvVar(project.id, "DUP", "b")).toThrow(/already exists in this project/);
  });

  it("allows the same name in two different projects", () => {
    const { project } = fixture();
    const project2 = createProject("Site2")!;
    createEnvVar(project.id, "X", "a");
    expect(() => createEnvVar(project2.id, "X", "b")).not.toThrow();
  });

  it("rejects a rename onto an existing name in the same project", () => {
    const { project } = fixture();
    createEnvVar(project.id, "TAKEN", "a");
    const other = createEnvVar(project.id, "FREE", "b")!;
    expect(() => updateEnvVar(other.id, { name: "TAKEN" })).toThrow(
      /already exists in this project/,
    );
  });

  it("allows a rename that keeps the var's own name (self-collision excluded)", () => {
    const { project } = fixture();
    const envVar = createEnvVar(project.id, "KEEP", "a")!;
    expect(() => updateEnvVar(envVar.id, { name: "KEEP", value: "b" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Value encryption — values are encrypted at rest and only decrypted on the
// dedicated read paths (the /value endpoint and run-payload composition).
// ---------------------------------------------------------------------------

describe("env-var value encryption", () => {
  it("stores the value encrypted and round-trips it through decryption", () => {
    const { project } = fixture();
    const envVar = createEnvVar(project.id, "SECRET", "s3cret-value")!;

    const raw = getDb()
      .prepare(`SELECT encrypted_value FROM env_vars WHERE id = ?`)
      .get(envVar.id) as { encrypted_value: string };
    expect(raw.encrypted_value).not.toContain("s3cret-value");

    expect(getEnvVarDecryptedValue(envVar.id)).toBe("s3cret-value");
  });

  it("getEnvVarById never carries the encrypted value", () => {
    const { project } = fixture();
    const envVar = createEnvVar(project.id, "SECRET", "v")!;
    expect(getEnvVarById(envVar.id)).not.toHaveProperty("encrypted_value");
  });

  it("getEnvVarDecryptedValue returns null for an unknown id", () => {
    expect(getEnvVarDecryptedValue("nope")).toBeNull();
  });

  it("decrypts values in the job composition map", () => {
    const { project, job } = fixture();
    const a = createEnvVar(project.id, "A_VAR", "a-val")!;
    const b = createEnvVar(project.id, "B_VAR", "b-val")!;
    linkEnvVarToJob(job.id, a.id);
    linkEnvVarToJob(job.id, b.id);

    expect(getDecryptedEnvVarsForJob(job.id)).toEqual({ A_VAR: "a-val", B_VAR: "b-val" });
  });

  it("an updated value re-encrypts and round-trips", () => {
    const { project } = fixture();
    const envVar = createEnvVar(project.id, "ROTATE", "old-value")!;
    updateEnvVar(envVar.id, { value: "new-value" });
    expect(getEnvVarDecryptedValue(envVar.id)).toBe("new-value");
  });
});
