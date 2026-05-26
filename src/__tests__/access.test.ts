import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { setDb, resetDb, initializeSchema } from "@/lib/db/schema";
import {
  ROLE_RANK,
  meets,
  resolveAccess,
  orgIdForProject,
  orgIdForAgent,
  orgIdForJob,
  orgIdForRun,
  orgIdForResource,
} from "@/lib/db/access";
import {
  createOrg,
  createProject,
  createUser,
  createAgent,
  createJob,
  createRun,
  createDoc,
  createEnvVar,
  createDatabase,
  addMembership,
  updateUser,
} from "@/lib/db/queries";

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

// ===========================================================================
// ROLE_RANK + meets
// ===========================================================================

describe("ROLE_RANK + meets", () => {
  it("orders viewer < editor < instance_admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.instance_admin);
  });

  it("meets returns false for a null role", () => {
    expect(meets(null, "viewer")).toBe(false);
  });

  it("editor meets viewer + editor but not instance_admin", () => {
    expect(meets("editor", "viewer")).toBe(true);
    expect(meets("editor", "editor")).toBe(true);
    expect(meets("editor", "instance_admin")).toBe(false);
  });

  it("instance_admin meets every minimum", () => {
    expect(meets("instance_admin", "viewer")).toBe(true);
    expect(meets("instance_admin", "editor")).toBe(true);
    expect(meets("instance_admin", "instance_admin")).toBe(true);
  });

  it("viewer does not meet editor", () => {
    expect(meets("viewer", "editor")).toBe(false);
  });
});

// ===========================================================================
// resolveAccess
// ===========================================================================

describe("resolveAccess", () => {
  it("returns 'instance_admin' for an instance admin in any org", () => {
    const orgA = createOrg("A")!;
    const orgB = createOrg("B")!;
    const admin = createUser("admin@x.com", "pw", "Admin", { isInstanceAdmin: true })!;
    expect(resolveAccess(admin.id, orgA.id)).toBe("instance_admin");
    expect(resolveAccess(admin.id, orgB.id)).toBe("instance_admin");
  });

  it("returns the membership role for a member", () => {
    const org = createOrg("A")!;
    const editor = createUser("e@x.com", "pw", "E")!;
    const viewer = createUser("v@x.com", "pw", "V")!;
    addMembership(editor.id, org.id, "editor");
    addMembership(viewer.id, org.id, "viewer");
    expect(resolveAccess(editor.id, org.id)).toBe("editor");
    expect(resolveAccess(viewer.id, org.id)).toBe("viewer");
  });

  it("returns null for a non-member of the org", () => {
    const orgA = createOrg("A")!;
    const orgB = createOrg("B")!;
    const user = createUser("u@x.com", "pw", "U")!;
    addMembership(user.id, orgA.id, "editor");
    // member of A, not of B
    expect(resolveAccess(user.id, orgB.id)).toBeNull();
  });

  it("returns null for an unknown user", () => {
    const org = createOrg("A")!;
    expect(resolveAccess("ghost", org.id)).toBeNull();
  });

  it("reflects a promotion to instance admin", () => {
    const orgA = createOrg("A")!;
    const orgB = createOrg("B")!;
    const user = createUser("u@x.com", "pw", "U")!;
    addMembership(user.id, orgA.id, "viewer");
    expect(resolveAccess(user.id, orgB.id)).toBeNull();
    updateUser(user.id, { isInstanceAdmin: true });
    expect(resolveAccess(user.id, orgB.id)).toBe("instance_admin");
  });
});

// ===========================================================================
// orgIdFor* hierarchy resolution
// ===========================================================================

describe("orgIdFor* resolution", () => {
  it("resolves through the full hierarchy", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    expect(orgIdForProject(project.id)).toBe(org.id);
    expect(orgIdForAgent(agent.id)).toBe(org.id);
    expect(orgIdForJob(job.id)).toBe(org.id);
    expect(orgIdForRun(run.id)).toBe(org.id);
  });

  it("returns null for non-existent ids", () => {
    expect(orgIdForProject("nope")).toBeNull();
    expect(orgIdForAgent("nope")).toBeNull();
    expect(orgIdForJob("nope")).toBeNull();
    expect(orgIdForRun("nope")).toBeNull();
  });
});

// ===========================================================================
// orgIdForResource — every kind
// ===========================================================================

describe("orgIdForResource", () => {
  it("resolves project / agent / job / run", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    const agent = createAgent(project.id, "Dev");
    const job = createJob(project.id, agent.id, { name: "J", schedule: '{"every":60}' })!;
    const run = createRun(job.id, agent.id)!;

    expect(orgIdForResource("project", project.id)).toBe(org.id);
    expect(orgIdForResource("agent", agent.id)).toBe(org.id);
    expect(orgIdForResource("job", job.id)).toBe(org.id);
    expect(orgIdForResource("run", run.id)).toBe(org.id);
  });

  it("resolves dual-tier resources (org-level and project-level)", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;

    const orgDoc = createDoc(org.id, null, "Brand")!;
    const projDoc = createDoc(org.id, project.id, "Spec")!;
    const orgEnv = createEnvVar(org.id, null, "API_KEY", "secret")!;
    const projEnv = createEnvVar(org.id, project.id, "DB_URL", "url")!;
    const orgDb = createDatabase(org.id, null, "shared", [{ name: "v", type: "TEXT" }]);
    const projDb = createDatabase(org.id, project.id, "local", [{ name: "v", type: "TEXT" }]);

    expect(orgIdForResource("doc", orgDoc.id)).toBe(org.id);
    expect(orgIdForResource("doc", projDoc.id)).toBe(org.id);
    expect(orgIdForResource("env_var", orgEnv.id)).toBe(org.id);
    expect(orgIdForResource("env_var", projEnv.id)).toBe(org.id);
    expect(orgIdForResource("database", orgDb.id)).toBe(org.id);
    expect(orgIdForResource("database", projDb.id)).toBe(org.id);
  });

  it("returns null for a non-existent resource", () => {
    expect(orgIdForResource("doc", "nope")).toBeNull();
    expect(orgIdForResource("env_var", "nope")).toBeNull();
    expect(orgIdForResource("database", "nope")).toBeNull();
  });
});

// ===========================================================================
// env_var query-layer uniqueness (project-over-org override allowed)
// ===========================================================================

describe("env_var uniqueness (query layer)", () => {
  it("allows the same name at org level and project level (override)", () => {
    const org = createOrg("Acme")!;
    const project = createProject(org.id, "Site")!;
    expect(() => createEnvVar(org.id, null, "TOKEN", "org-val")).not.toThrow();
    expect(() => createEnvVar(org.id, project.id, "TOKEN", "proj-val")).not.toThrow();
  });

  it("rejects a duplicate name within the same tier", () => {
    const org = createOrg("Acme")!;
    createEnvVar(org.id, null, "TOKEN", "a");
    expect(() => createEnvVar(org.id, null, "TOKEN", "b")).toThrow(/already exists/);
  });
});
