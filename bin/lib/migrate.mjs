// `harbour migrate` — translate a v1 (main-branch) database into a fresh v2
// install. v2 is a clean-break schema with no in-place migration path
// (src/lib/db/schema.ts), so this is a structural *translation*, not a copy:
//
//   • v1 is flat (global agents/jobs/docs/secrets/databases; optional
//     many-to-many `projects`). v2 is org → project (mandatory) → agents/jobs,
//     with dual-tier (org- or project-level) docs/secrets/tables.
//   • Secrets are re-keyed: decrypted with the backup's encryption.key and
//     re-encrypted under the fresh install's key (same AES-256-GCM format).
//   • Runs and everything hanging off them (activity, output, attachments,
//     uploads) are intentionally dropped.
//
// Mirrors the raw-SQL style of bootstrap.mjs (no TS build needed). It writes
// rows in the exact shapes src/lib/db/* would produce; the round-trip test
// (src/__tests__/migrate-v1.test.ts) asserts the result against the real query
// helpers, and migrate-schedule-parity.test.ts locks the ported scheduler to
// the TS original.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { getHarbourDir } from "./config.mjs";
import { getNextRunTime, normalizeSchedule } from "./schedule.mjs";

const defaultDbPath = () => process.env.HARBOUR_DB_PATH || path.join(getHarbourDir(), "harbour.db");

// ── small helpers mirrored from src/lib ──────────────────────────────────────

const uuid = () => crypto.randomUUID();

// slugify (src/lib/slug.ts)
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// v1's flat workspace dir slug (bin/lib/providers.mjs @ main): lowercase, every
// char outside [a-z0-9-] → '-', NO collapse/trim. Differs from slugify, so it's
// reproduced exactly to locate the old workspace under the backup.
function v1AgentSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// sanitizeName / toTableName (src/lib/db/tables.ts)
function sanitizeName(input) {
  const clean = input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (!clean) throw new Error(`Invalid table name: ${JSON.stringify(input)}`);
  return clean;
}
const toTableName = (name) => `t_${sanitizeName(name)}`;

// AES-256-GCM matching src/lib/encryption.ts ("iv:authTag:ciphertext", all hex)
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

function decryptWith(key, ciphertext) {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString(
    "utf-8",
  );
}

function readKey(keyFile) {
  const hex = fs.readFileSync(keyFile, "utf-8").trim();
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error(`Encryption key at ${keyFile} is not 64 hex chars`);
  return key;
}

const systemTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── core migration (pure, testable) ──────────────────────────────────────────

/**
 * Translate a v1 database into a fresh v2 database.
 *
 * @param {object} opts
 * @param {string} opts.fromDir   v1 backup dir (contains harbour.db + encryption.key)
 * @param {string} opts.toDb      path to the fresh v2 harbour.db (already has the v2 schema)
 * @param {string} [opts.newKeyFile]  v2 encryption.key (defaults to <toDb dir>/encryption.key)
 * @param {string} [opts.orgName] name for the single org everything lands under
 * @param {boolean} [opts.dryRun] do all the work then roll back, reporting what would happen
 * @param {Date}   [opts.now]     clock for next_run_at (tests inject a fixed time)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{counts:{users:number,projects:number,agents:number,agentJobs:number,workflows:number,docs:number,envVars:number,tables:number,tableRows:number,jobLinks:number,adminKeys:number,skippedOneOff:number},warnings:string[],workspaces:{agent:string,oldPath:string,newPath:string,hasGit:boolean}[],org:{id:string|null,name:string}}}
 */
export function migrateFromV1(opts) {
  const {
    fromDir,
    toDb,
    orgName = "Default",
    dryRun = false,
    now = new Date(),
    log = () => {},
  } = opts;

  const v1Path = path.join(fromDir, "harbour.db");
  const oldKeyFile = path.join(fromDir, "encryption.key");
  const home = path.dirname(toDb); // v2 HARBOUR_HOME (workspaces live under it)
  const newKeyFile = opts.newKeyFile || path.join(home, "encryption.key");

  if (!fs.existsSync(v1Path)) throw new Error(`No v1 database at ${v1Path}`);
  if (!fs.existsSync(oldKeyFile)) throw new Error(`No encryption.key in backup dir ${fromDir}`);
  if (!fs.existsSync(toDb))
    throw new Error(`No v2 database at ${toDb} — run 'harbour setup' first`);

  const v1 = new Database(v1Path, { readonly: true });
  const v2 = new Database(toDb);
  v2.pragma("foreign_keys = ON");
  v2.pragma("busy_timeout = 5000"); // coexist with a running server's connection

  // The full v2 schema and the install's encryption.key are both created on the
  // server's first boot (initializeSchema), not by `harbour setup`. If the schema
  // isn't there yet, say so plainly before anything else fails cryptically.
  const newKeyReady = !!process.env.HARBOUR_ENCRYPTION_KEY || fs.existsSync(newKeyFile);
  if (!hasTable(v2, "orgs") || !newKeyReady) {
    v1.close();
    v2.close();
    throw new Error(
      "This install isn't initialized yet (no 'orgs' table / encryption key). Start the " +
        "server once ('npm start') so it creates the schema and key, then re-run 'harbour migrate'.",
    );
  }

  const oldKey = readKey(oldKeyFile);
  const newKey = process.env.HARBOUR_ENCRYPTION_KEY
    ? Buffer.from(process.env.HARBOUR_ENCRYPTION_KEY, "hex")
    : readKey(newKeyFile);

  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    log(`  ! ${m}`);
  };
  const workspaces = []; // { agent, oldPath, newPath, hasGit } — repos to move/re-clone
  const counts = {
    users: 0,
    projects: 0,
    agents: 0,
    agentJobs: 0,
    workflows: 0,
    docs: 0,
    envVars: 0,
    tables: 0,
    tableRows: 0,
    jobLinks: 0,
    adminKeys: 0,
    skippedOneOff: 0,
  };

  // Pre-flight: the target must be a fresh install (no orgs yet).
  const orgCount = v2.prepare(`SELECT COUNT(*) AS n FROM orgs`).get().n;
  if (orgCount > 0) {
    v1.close();
    v2.close();
    throw new Error(
      "Target database already has orgs — migrate only runs against a fresh install. " +
        "Wipe ~/.harbour, re-run 'harbour setup', then migrate.",
    );
  }

  const admin = v2.prepare(`SELECT id, email FROM users WHERE is_instance_admin = 1 LIMIT 1`).get();
  const adminId = admin?.id || null;

  // v1 timezone is global; v2 reads it from settings too (org timezone is also
  // recorded for forward-compat).
  const tzRow = safeGet(v1, `SELECT value FROM settings WHERE key = 'timezone'`);
  const tz = tzRow?.value || systemTz();

  v2.exec("BEGIN");
  try {
    // ── org ──────────────────────────────────────────────────────────────
    const orgId = uuid();
    const orgSlug = uniqueSlug(v2, "orgs", "slug", null, slugify(orgName) || "org");
    v2.prepare(`INSERT INTO orgs (id, name, slug, settings) VALUES (?, ?, ?, ?)`).run(
      orgId,
      orgName,
      orgSlug,
      JSON.stringify({ timezone: tz }),
    );

    // ── users + memberships ────────────────────────────────────────────────
    // v1 stored bcrypt password hashes; v2 verifies argon2id, so hashes can't
    // carry over. Migrated users get a NULL password (the admin sends each a
    // set-password link from the dashboard). The setup admin is matched by
    // email and reused, never duplicated.
    const userMap = new Map(); // v1 user id -> v2 user id
    for (const u of v1.prepare(`SELECT * FROM users`).all()) {
      if (admin && u.email.toLowerCase() === admin.email.toLowerCase()) {
        userMap.set(u.id, adminId);
        ensureMembership(v2, adminId, orgId);
        continue;
      }
      const id = uuid();
      v2.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, is_instance_admin) VALUES (?, ?, NULL, ?, 0)`,
      ).run(id, u.email, u.display_name);
      ensureMembership(v2, id, orgId);
      userMap.set(u.id, id);
      counts.users++;
      warn(
        `user ${u.email} migrated with no password — send a set-password link from the dashboard`,
      );
    }

    // ── projects ───────────────────────────────────────────────────────────
    const projectMap = new Map(); // v1 project id -> v2 project id
    for (const p of v1.prepare(`SELECT * FROM projects`).all()) {
      const id = uuid();
      v2.prepare(`INSERT INTO projects (id, org_id, name, slug) VALUES (?, ?, ?, ?)`).run(
        id,
        orgId,
        p.name,
        uniqueSlug(v2, "projects", "slug", orgId, slugify(p.name) || "project"),
      );
      projectMap.set(p.id, id);
      counts.projects++;
    }

    // A landing project for agents/jobs that belonged to no v1 project.
    let defaultProjectId = null;
    const ensureDefaultProject = () => {
      if (defaultProjectId) return defaultProjectId;
      defaultProjectId = uuid();
      v2.prepare(`INSERT INTO projects (id, org_id, name, slug) VALUES (?, ?, ?, ?)`).run(
        defaultProjectId,
        orgId,
        "Default",
        uniqueSlug(v2, "projects", "slug", orgId, "default"),
      );
      counts.projects++;
      return defaultProjectId;
    };

    // helper: resolve a resource's single v1 project membership -> v2 project,
    // returning null (org-level) when it belongs to zero or many projects.
    const tierFor = (junction, idCol, resourceId) => {
      const links = v1
        .prepare(`SELECT project_id FROM ${junction} WHERE ${idCol} = ?`)
        .all(resourceId);
      if (links.length === 1) {
        const mapped = projectMap.get(links[0].project_id);
        if (mapped) return mapped;
      }
      return null; // 0 or many → org-level
    };

    // ── agents ───────────────────────────────────────────────────────────
    const agentMap = new Map(); // v1 agent id -> { id, projectId }
    for (const a of v1.prepare(`SELECT * FROM agents`).all()) {
      const memberships = v1
        .prepare(`SELECT project_id FROM project_agents WHERE agent_id = ?`)
        .all(a.id)
        .map((r) => projectMap.get(r.project_id))
        .filter(Boolean);
      let projectId;
      if (memberships.length >= 1) {
        projectId = memberships[0];
        if (memberships.length > 1)
          warn(`agent "${a.name}" was in ${memberships.length} projects — placed in the first`);
      } else {
        projectId = ensureDefaultProject();
      }

      const id = uuid();
      const placement = a.remote ? "remote" : "local";
      const agentSlug = uniqueSlug(
        v2,
        "agents",
        "slug",
        projectId,
        slugify(a.name) || "agent",
        "project_id",
      );
      v2.prepare(
        `INSERT INTO agents (id, project_id, name, slug, description, cli, model, thinking, eager, placement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        projectId,
        a.name,
        agentSlug,
        a.description || null,
        a.cli || null,
        a.model || null,
        a.thinking || null,
        a.eager ? 1 : 0,
        placement,
      );
      agentMap.set(a.id, { id, projectId, placement });
      counts.agents++;
      if (!a.cli)
        warn(
          `agent "${a.name}" was an external (API-key) agent with no CLI — it has no runner in v2; ` +
            "assign a CLI or reconnect it via the runner protocol",
        );

      // Workspace reconciliation: v1 nested workspaces flat under one slug; v2
      // nests <org>/<project>/<agent>. If the backup holds a populated workspace
      // (especially a git repo), the operator must move or re-clone it to the new
      // path — the runner will otherwise create a fresh empty dir. Report the
      // exact old → new mapping; never move data ourselves (repos can be large
      // and the operator may prefer a clean re-clone).
      const oldWs = path.join(fromDir, "workspaces", v1AgentSlug(a.name));
      if (fs.existsSync(oldWs) && fs.readdirSync(oldWs).length > 0) {
        const projSlug = v2.prepare(`SELECT slug FROM projects WHERE id = ?`).get(projectId).slug;
        workspaces.push({
          agent: a.name,
          oldPath: oldWs,
          newPath: path.join(home, "workspaces", orgSlug, projSlug, agentSlug),
          hasGit: fs.existsSync(path.join(oldWs, ".git")),
        });
      }
    }

    // ── docs (latest revision only) ────────────────────────────────────────
    const docMap = new Map(); // v1 doc id -> { id, projectId|null }
    for (const d of v1.prepare(`SELECT * FROM docs`).all()) {
      const projectId = tierFor("project_docs", "doc_id", d.id);
      const id = uuid();
      const [authorType, authorId] = mapAuthor(
        d.created_by_type,
        d.created_by_id,
        userMap,
        agentMap,
      );
      v2.prepare(
        `INSERT INTO docs (id, org_id, project_id, title, pinned, created_by_type, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, projectId, d.title, d.pinned ? 1 : 0, authorType, authorId);

      const rev = safeGet(
        v1,
        `SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        d.id,
      );
      if (rev?.content) {
        const [rAuthorType, rAuthorId] = mapAuthor(
          rev.author_type,
          rev.author_id,
          userMap,
          agentMap,
        );
        v2.prepare(
          `INSERT INTO doc_revisions (id, doc_id, content, author_type, author_id) VALUES (?, ?, ?, ?, ?)`,
        ).run(uuid(), id, rev.content, rAuthorType, rAuthorId);
      }
      docMap.set(d.id, { id, projectId });
      counts.docs++;
    }

    // ── env vars (decrypt with old key, re-encrypt with new) ───────────────
    const envMap = new Map(); // v1 env var id -> { id, projectId|null }
    for (const e of v1.prepare(`SELECT * FROM env_vars`).all()) {
      let plaintext;
      try {
        plaintext = decryptWith(oldKey, e.encrypted_value);
      } catch {
        warn(`secret "${e.name}" could not be decrypted with the backup key — skipped`);
        continue;
      }
      const projectId = tierFor("project_env_vars", "env_var_id", e.id);
      const id = uuid();
      v2.prepare(
        `INSERT INTO env_vars (id, org_id, project_id, name, encrypted_value, pinned) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, projectId, e.name, encryptWith(newKey, plaintext), e.pinned ? 1 : 0);
      envMap.set(e.id, { id, projectId });
      counts.envVars++;
    }

    // ── tables (v1 "databases") + their physical rows ──────────────────────
    const tableMap = new Map(); // v1 database id -> { id, projectId|null }
    for (const t of v1.prepare(`SELECT * FROM databases`).all()) {
      const cols = v1.prepare(`PRAGMA table_info("${t.table_name}")`).all();
      if (cols.length === 0) {
        warn(`table "${t.name}" has no underlying data table — skipped`);
        continue;
      }
      const projectId = tierFor("project_databases", "database_id", t.id);
      const id = uuid();
      const newTableName = `${toTableName(t.name)}_${id.replace(/-/g, "").slice(0, 8)}`;
      const dataCols = cols.filter((c) => c.name !== "_id");
      const colDefs = dataCols.map((c) => {
        let def = `"${c.name}" ${c.type || "TEXT"}`;
        if (c.notnull) def += " NOT NULL";
        if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
        return def;
      });
      const createSql = `CREATE TABLE "${newTableName}" (_id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(", ")})`;
      v2.exec(createSql);
      v2.prepare(
        `INSERT INTO tables (id, org_id, project_id, name, table_name) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, orgId, projectId, sanitizeName(t.name), newTableName);
      v2.prepare(
        `INSERT INTO table_migrations (id, table_id, version, description, sql) VALUES (?, ?, 1, ?, ?)`,
      ).run(uuid(), id, "Create table", createSql);

      // Copy rows verbatim (including _id to keep row identity stable).
      const rows = v1.prepare(`SELECT * FROM "${t.table_name}"`).all();
      if (rows.length) {
        const allCols = cols.map((c) => c.name);
        const ins = v2.prepare(
          `INSERT INTO "${newTableName}" (${allCols.map((c) => `"${c}"`).join(", ")}) VALUES (${allCols
            .map(() => "?")
            .join(", ")})`,
        );
        for (const r of rows) ins.run(allCols.map((c) => r[c]));
        counts.tableRows += rows.length;
      }
      tableMap.set(t.id, { id, projectId });
      counts.tables++;
    }

    // ── jobs ───────────────────────────────────────────────────────────────
    // v1 job shapes → v2:
    //   workflow_only=1            → v2 workflow job (kind='workflow', no agent)
    //   agent job + workflow_command → v2 agent job with a prerun gate
    //   plain agent job            → v2 agent job
    // one-off jobs are dropped (no v2 equivalent; they've already fired).
    const linkResources = (jobId, v1JobId, jobProjectId) => {
      const link = (junction, idCol, map, v2Junction, v2Col) => {
        for (const row of v1.prepare(`SELECT * FROM ${junction} WHERE job_id = ?`).all(v1JobId)) {
          const res = map.get(row[idCol]);
          if (!res) continue;
          // v2 tier rule: a job may link an org-level resource, or a resource in
          // its own project. An org-level job can only link org-level resources.
          if (res.projectId !== null && res.projectId !== jobProjectId) {
            warn(`job link skipped: resource is project-scoped but job is in a different tier`);
            continue;
          }
          v2.prepare(`INSERT OR IGNORE INTO ${v2Junction} (job_id, ${v2Col}) VALUES (?, ?)`).run(
            jobId,
            res.id,
          );
          counts.jobLinks++;
        }
      };
      link("job_docs", "doc_id", docMap, "job_docs", "doc_id");
      link("job_env_vars", "env_var_id", envMap, "job_env_vars", "env_var_id");
      link("job_databases", "database_id", tableMap, "job_tables", "table_id");
    };

    for (const j of v1.prepare(`SELECT * FROM jobs`).all()) {
      if (j.one_off) {
        counts.skippedOneOff++;
        continue;
      }
      const schedule = normalizeSchedule(j.schedule);
      let active = j.active ? 1 : 0;
      if (!schedule && active) {
        warn(`job "${j.name}" has an unparseable schedule (${j.schedule}) — migrated inactive`);
        active = 0;
      }
      const nextRunAt = active && schedule ? getNextRunTime(schedule, now, tz) : null;
      const id = uuid();
      const agent = j.agent_id ? agentMap.get(j.agent_id) : null;

      const isWorkflow = j.workflow_only;
      if (isWorkflow || (!agent && j.workflow_command)) {
        // Workflow job (no agent in v2).
        if (!j.workflow_command) {
          warn(`workflow job "${j.name}" has no command — skipped`);
          continue;
        }
        // Project from its old agent, else its single project_jobs membership, else org-level.
        const projectId = agent ? agent.projectId : tierFor("project_jobs", "job_id", j.id);
        v2.prepare(
          `INSERT INTO jobs (id, org_id, project_id, kind, agent_id, name, description, instructions, schedule, workflow_runtime, workflow_script, placement, timeout_minutes, active, next_run_at)
           VALUES (?, ?, ?, 'workflow', NULL, ?, ?, NULL, ?, 'bash', ?, ?, ?, ?, ?)`,
        ).run(
          id,
          orgId,
          projectId,
          j.name,
          j.description || null,
          schedule || j.schedule,
          j.workflow_command,
          agent?.placement || "local",
          j.timeout_minutes ?? 30,
          active,
          nextRunAt,
        );
        linkResources(id, j.id, projectId);
        counts.workflows++;
      } else {
        // Agent job.
        if (!agent) {
          warn(`job "${j.name}" has no agent and no workflow command — skipped`);
          continue;
        }
        const prerunRuntime = j.workflow_command ? "bash" : null;
        v2.prepare(
          `INSERT INTO jobs (id, org_id, project_id, kind, agent_id, name, description, instructions, schedule, prerun_runtime, prerun_script, model, thinking, title_format, timeout_minutes, active, next_run_at)
           VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          orgId,
          agent.projectId,
          agent.id,
          j.name,
          j.description || null,
          j.instructions || null,
          schedule || j.schedule,
          prerunRuntime,
          j.workflow_command || null,
          j.model || null,
          j.thinking || null,
          j.title_format || null,
          j.timeout_minutes ?? 30,
          active,
          nextRunAt,
        );
        linkResources(id, j.id, agent.projectId);
        counts.agentJobs++;
      }
    }

    // ── admin API keys (sha256 hashes are compatible → keys keep working) ──
    if (hasTable(v1, "admin_api_keys")) {
      for (const k of v1.prepare(`SELECT * FROM admin_api_keys`).all()) {
        const createdBy = userMap.get(k.created_by_user_id) || adminId;
        if (!createdBy) continue;
        v2.prepare(
          `INSERT INTO admin_api_keys (id, name, api_key_hash, created_by_user_id, last_used_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(uuid(), k.name, k.api_key_hash, createdBy, k.last_used_at ?? null);
        counts.adminKeys++;
      }
    }

    // ── settings ───────────────────────────────────────────────────────────
    v2.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('timezone', ?)`).run(tz);

    if (dryRun) {
      v2.exec("ROLLBACK");
    } else {
      v2.exec("COMMIT");
    }
  } catch (err) {
    v2.exec("ROLLBACK");
    v1.close();
    v2.close();
    throw err;
  }

  v1.close();
  v2.close();
  return {
    counts,
    warnings,
    workspaces,
    org: { id: dryRun ? null : "(committed)", name: orgName },
  };
}

// ── tiny SQL helpers ─────────────────────────────────────────────────────────

function safeGet(db, sql, ...args) {
  try {
    return db.prepare(sql).get(...args);
  } catch {
    return undefined;
  }
}

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function ensureMembership(db, userId, orgId) {
  db.prepare(
    `INSERT OR IGNORE INTO memberships (user_id, org_id, role) VALUES (?, ?, 'editor')`,
  ).run(userId, orgId);
}

function mapAuthor(type, id, userMap, agentMap) {
  if (type === "user") return ["user", userMap.get(id) || null];
  if (type === "agent") {
    const a = agentMap.get(id);
    return ["agent", a ? a.id : null];
  }
  return [null, null];
}

// Ensure a slug is unique within its scope (whole table, or per scopeCol).
function uniqueSlug(db, table, slugCol, scopeId, base, scopeCol = "org_id") {
  const scoped = scopeId !== null && scopeId !== undefined;
  const exists = (slug) =>
    scoped
      ? db
          .prepare(`SELECT 1 FROM ${table} WHERE ${scopeCol} = ? AND ${slugCol} = ?`)
          .get(scopeId, slug)
      : db.prepare(`SELECT 1 FROM ${table} WHERE ${slugCol} = ?`).get(slug);
  if (!exists(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
}

// ── CLI wrapper ──────────────────────────────────────────────────────────────

export async function runMigrate(argv) {
  const args = parseArgs(argv);
  const fromDir = args.from || path.join(getHarbourDir(), "..", ".harbour-v1-backup");
  const toDb = args.db || defaultDbPath();
  const orgName = args.org || "Default";

  console.log(`\nHarbour v1 → v2 migration`);
  console.log(`  from:  ${path.join(fromDir, "harbour.db")}`);
  console.log(`  into:  ${toDb}`);
  console.log(`  org:   ${orgName}`);
  console.log(args.dryRun ? `  mode:  DRY RUN (no changes written)\n` : "");

  if (!args.dryRun && !args.yes) {
    const ok = await confirm(
      "This writes into the fresh install above (which must have no orgs yet). Continue? [y/N] ",
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const report = migrateFromV1({
    fromDir,
    toDb,
    orgName,
    dryRun: args.dryRun,
    log: (m) => console.log(m),
  });

  console.log(`\n${args.dryRun ? "Would migrate" : "Migrated"}:`);
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k.padEnd(14)} ${v}`);
  if (report.warnings.length) console.log(`\n${report.warnings.length} warning(s) above.`);

  if (report.workspaces.length) {
    console.log(`\nAgent workspaces to reconcile (v1 was flat; v2 nests <org>/<project>/<agent>):`);
    for (const w of report.workspaces) {
      console.log(`  ${w.agent}${w.hasGit ? " (git repo)" : ""}`);
      console.log(`    from: ${w.oldPath}`);
      console.log(`    to:   ${w.newPath}`);
    }
    console.log(
      `  → Move or re-clone each into its new path before running it. Agents only work in\n` +
        `    their own workspace, so anything left at the old path is invisible to v2.`,
    );
  }

  if (!args.dryRun) {
    console.log(
      `\nDone. Next: verify each migrated job's instructions still match how v2 accesses\n` +
        `tables/secrets/prerun gates (see docs/guides/migrating-from-v1.md), reconcile the\n` +
        `workspaces above, then start the server and schedule the runner with 'harbour install'.`,
    );
  }
}

function parseArgs(argv) {
  const out = { dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a.startsWith("--from=")) out.from = a.slice(7);
    else if (a.startsWith("--org=")) out.org = a.slice(6);
    else if (a.startsWith("--db=")) out.db = a.slice(5);
  }
  return out;
}

function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
