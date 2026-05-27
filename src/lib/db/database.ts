import { getDb } from "./schema";
import { v4 as uuid } from "uuid";

// --- Types ---

export type ColumnDef = {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL";
  required?: boolean;
  default?: string | number | null;
};

export type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: any;
  pk: number;
};

export type DatabaseMeta = {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  table_name: string;
  created_at: number;
  updated_at: number;
};

// --- Sanitization ---

const RESERVED = new Set([
  "abort", "action", "add", "after", "all", "alter", "always", "analyze",
  "and", "as", "asc", "attach", "autoincrement", "before", "begin", "between",
  "by", "cascade", "case", "cast", "check", "collate", "column", "commit",
  "conflict", "constraint", "create", "cross", "current", "current_date",
  "current_time", "current_timestamp", "database", "default", "deferrable",
  "deferred", "delete", "desc", "detach", "distinct", "do", "drop", "each",
  "else", "end", "escape", "except", "exclude", "exclusive", "exists",
  "explain", "fail", "filter", "first", "following", "for", "foreign", "from",
  "full", "glob", "group", "groups", "having", "if", "ignore", "immediate",
  "in", "index", "indexed", "initially", "inner", "insert", "instead",
  "intersect", "into", "is", "isnull", "join", "key", "last", "left", "like",
  "limit", "match", "materialized", "natural", "no", "not", "nothing",
  "notnull", "null", "nulls", "of", "offset", "on", "or", "order", "others",
  "outer", "over", "partition", "plan", "pragma", "preceding", "primary",
  "query", "raise", "range", "recursive", "references", "regexp", "reindex",
  "release", "rename", "replace", "restrict", "returning", "right",
  "rollback", "row", "rows", "savepoint", "select", "set", "table", "temp",
  "temporary", "then", "ties", "to", "transaction", "trigger", "unbounded",
  "union", "unique", "update", "using", "vacuum", "values", "view", "virtual",
  "when", "where", "window", "with", "without",
]);

function sanitizeName(input: string): string {
  // Lowercase, replace non-alphanumeric with underscore, collapse, trim
  const clean = input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (!clean) throw new Error("Invalid name: must contain alphanumeric characters");
  if (RESERVED.has(clean)) throw new Error(`Invalid name: "${clean}" is a reserved word`);
  return clean;
}

function toTableName(name: string): string {
  return `d_${sanitizeName(name)}`;
}

// Validate a column name for use in dynamic SQL
function safeColumnName(name: string): string {
  const clean = sanitizeName(name);
  if (clean === "_id") throw new Error('Column name "_id" is reserved');
  return clean;
}

// --- Database CRUD ---

export function createDatabase(orgId: string, projectId: string | null, name: string, columns: ColumnDef[]): DatabaseMeta & { columns: ColumnInfo[] } {
  const db = getDb();
  const id = uuid();
  const safeName = sanitizeName(name);
  // Suffix the physical table name with a short slice of the id so the same
  // logical name can exist in different orgs/projects without colliding on the
  // globally-unique table_name.
  const tableName = `${toTableName(name)}_${id.replace(/-/g, "").slice(0, 8)}`;

  // Validate columns
  if (!columns.length) throw new Error("At least one column is required");
  const colDefs = columns.map(c => {
    const colName = safeColumnName(c.name);
    let def = `"${colName}" ${c.type}`;
    if (c.required) def += " NOT NULL";
    if (c.default !== undefined && c.default !== null) {
      def += ` DEFAULT ${typeof c.default === "string" ? `'${c.default.replace(/'/g, "''")}'` : c.default}`;
    }
    return def;
  });

  const createSql = `CREATE TABLE "${tableName}" (_id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(", ")})`;

  // Register metadata + create table in a transaction
  db.transaction(() => {
    db.prepare(
      `INSERT INTO databases (id, org_id, project_id, name, table_name) VALUES (?, ?, ?, ?, ?)`
    ).run(id, orgId, projectId, safeName, tableName);

    db.exec(createSql);

    // Record as migration v1
    db.prepare(
      `INSERT INTO database_migrations (id, database_id, version, description, sql) VALUES (?, ?, 1, ?, ?)`
    ).run(uuid(), id, "Create table", createSql);
  })();

  return getDatabaseById(id)!;
}

export function getDatabaseById(id: string): (DatabaseMeta & { columns: ColumnInfo[] }) | null {
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM databases WHERE id = ?`).get(id) as DatabaseMeta | undefined;
  if (!meta) return null;
  const columns = db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[];
  return { ...meta, columns: columns.filter(c => c.name !== "_id") };
}

/**
 * Resolve a database by logical name within an org scope. Project-level matches
 * win over org-level ones of the same name (project-over-org override).
 */
export function getDatabaseByName(orgId: string, projectId: string | null, name: string): (DatabaseMeta & { columns: ColumnInfo[] }) | null {
  const db = getDb();
  const safeName = sanitizeName(name);
  const meta = db.prepare(`
    SELECT * FROM databases
    WHERE org_id = ? AND name = ? AND (project_id = ? OR project_id IS NULL)
    ORDER BY (project_id IS NULL) ASC
    LIMIT 1
  `).get(orgId, safeName, projectId) as DatabaseMeta | undefined;
  if (!meta) return null;
  const columns = db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[];
  return { ...meta, columns: columns.filter(c => c.name !== "_id") };
}

/**
 * Two-tier list: org-level databases (project_id IS NULL) plus the given
 * project's databases. Pass projectId=null to list only org-level databases.
 */
export function listDatabases(orgId: string, projectId: string | null = null) {
  const db = getDb();
  const projectFilter = projectId
    ? "AND (project_id = ? OR project_id IS NULL)"
    : "AND project_id IS NULL";
  const params = projectId ? [orgId, projectId] : [orgId];
  const metas = db.prepare(`
    SELECT * FROM databases
    WHERE org_id = ? ${projectFilter}
    ORDER BY name ASC
  `).all(...params) as DatabaseMeta[];

  return metas.map(meta => {
    const count = db.prepare(`SELECT COUNT(*) as count FROM "${meta.table_name}"`).get() as { count: number };
    const jobs = db.prepare(`
      SELECT j.id, j.name FROM job_databases jd
      JOIN jobs j ON jd.job_id = j.id
      WHERE jd.database_id = ?
    `).all(meta.id) as { id: string; name: string }[];
    return { ...meta, row_count: count.count, jobs };
  });
}

export function deleteDatabase(id: string) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM databases WHERE id = ?`).get(id) as { table_name: string } | undefined;
  if (!meta) return;

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS "${meta.table_name}"`);
    db.prepare(`DELETE FROM databases WHERE id = ?`).run(id);
  })();
}

// --- Schema Operations ---

export function addColumn(databaseId: string, column: ColumnDef) {
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM databases WHERE id = ?`).get(databaseId) as DatabaseMeta | undefined;
  if (!meta) throw new Error("Database not found");

  const colName = safeColumnName(column.name);
  let alterSql = `ALTER TABLE "${meta.table_name}" ADD COLUMN "${colName}" ${column.type}`;
  if (column.default !== undefined && column.default !== null) {
    alterSql += ` DEFAULT ${typeof column.default === "string" ? `'${column.default.replace(/'/g, "''")}'` : column.default}`;
  }
  // Note: NOT NULL requires a default for ALTER TABLE ADD COLUMN
  if (column.required) {
    if (column.default === undefined || column.default === null) {
      throw new Error("Required columns added via ALTER TABLE must have a default value");
    }
    alterSql += " NOT NULL";
  }

  const version = (db.prepare(
    `SELECT MAX(version) as v FROM database_migrations WHERE database_id = ?`
  ).get(databaseId) as { v: number })?.v || 0;

  db.transaction(() => {
    db.exec(alterSql);
    db.prepare(
      `INSERT INTO database_migrations (id, database_id, version, description, sql) VALUES (?, ?, ?, ?, ?)`
    ).run(uuid(), databaseId, version + 1, `Add column: ${colName}`, alterSql);
    db.prepare(`UPDATE databases SET updated_at = unixepoch() WHERE id = ?`).run(databaseId);
  })();

  return getDatabaseById(databaseId);
}

export function getDatabaseMigrations(databaseId: string) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM database_migrations WHERE database_id = ? ORDER BY version ASC`
  ).all(databaseId);
}

// --- Row Operations ---

export function getRows(databaseId: string, opts?: {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: "ASC" | "DESC";
}) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM databases WHERE id = ?`).get(databaseId) as { table_name: string } | undefined;
  if (!meta) return null;

  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  let sql = `SELECT * FROM "${meta.table_name}"`;

  if (opts?.orderBy) {
    // Validate orderBy against actual column names
    const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).map(c => c.name);
    if (!columns.includes(opts.orderBy)) {
      throw new Error(`Invalid orderBy column: "${opts.orderBy}"`);
    }
    const dir = opts?.order === "ASC" ? "ASC" : "DESC";
    sql += ` ORDER BY "${opts.orderBy}" ${dir}`;
  } else {
    sql += ` ORDER BY rowid DESC`;
  }

  sql += ` LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(limit, offset);

  const count = db.prepare(`SELECT COUNT(*) as count FROM "${meta.table_name}"`).get() as { count: number };

  return { rows, total: count.count, limit, offset };
}

export function insertRows(databaseId: string, rows: Record<string, any>[]) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM databases WHERE id = ?`).get(databaseId) as { table_name: string } | undefined;
  if (!meta) throw new Error("Database not found");
  if (!rows.length) return { inserted: 0 };

  // Get column info to validate
  const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).filter(c => c.name !== "_id");
  const validCols = new Set(columns.map(c => c.name));

  let inserted = 0;
  db.transaction(() => {
    for (const row of rows) {
      const keys = Object.keys(row).filter(k => validCols.has(k));
      if (!keys.length) continue;
      const placeholders = keys.map(() => "?").join(", ");
      const colNames = keys.map(k => `"${k}"`).join(", ");
      db.prepare(`INSERT INTO "${meta.table_name}" (${colNames}) VALUES (${placeholders})`).run(
        ...keys.map(k => row[k] ?? null)
      );
      inserted++;
    }
    db.prepare(`UPDATE databases SET updated_at = unixepoch() WHERE id = ?`).run(databaseId);
  })();

  return { inserted };
}

export function updateRow(databaseId: string, rowId: number, data: Record<string, any>) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM databases WHERE id = ?`).get(databaseId) as { table_name: string } | undefined;
  if (!meta) throw new Error("Database not found");

  const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).filter(c => c.name !== "_id");
  const validCols = new Set(columns.map(c => c.name));
  const keys = Object.keys(data).filter(k => validCols.has(k));
  if (!keys.length) throw new Error("No valid columns to update");

  const sets = keys.map(k => `"${k}" = ?`).join(", ");
  const values = keys.map(k => data[k] ?? null);

  db.transaction(() => {
    db.prepare(`UPDATE "${meta.table_name}" SET ${sets} WHERE _id = ?`).run(...values, rowId);
    db.prepare(`UPDATE databases SET updated_at = unixepoch() WHERE id = ?`).run(databaseId);
  })();

  return db.prepare(`SELECT * FROM "${meta.table_name}" WHERE _id = ?`).get(rowId);
}

export function deleteRow(databaseId: string, rowId: number) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM databases WHERE id = ?`).get(databaseId) as { table_name: string } | undefined;
  if (!meta) throw new Error("Database not found");

  db.transaction(() => {
    db.prepare(`DELETE FROM "${meta.table_name}" WHERE _id = ?`).run(rowId);
    db.prepare(`UPDATE databases SET updated_at = unixepoch() WHERE id = ?`).run(databaseId);
  })();
}

/**
 * Composed databases for a job's run payload (used by /next).
 *
 * Composition (per the v2 resource model) = all org-level databases of the
 * job's org + all project-level databases of the job's project + the job's
 * explicitly linked databases, de-duplicated by id. The payload `data` map is
 * keyed by the logical database name, so on a name collision the more-specific
 * tier wins: job-linked > project-level > org-level. Returns the winning
 * `{ name, table_name }` per logical name.
 */
export function getComposedDatabasesForJob(jobId: string): { name: string; table_name: string }[] {
  const db = getDb();

  const scope = db.prepare(`
    SELECT j.project_id, p.org_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).get(jobId) as { project_id: string; org_id: string } | undefined;
  if (!scope) return [];

  type Row = { id: string; name: string; table_name: string; project_id: string | null; linked: number };

  // Collect every candidate database across the three tiers. `linked` flags a
  // job-linked row; `project_id` distinguishes org- vs project-level. DISTINCT
  // de-dups the same database appearing in multiple tiers (e.g. project-level
  // AND job-linked).
  const rows = db.prepare(`
    SELECT id, name, table_name, project_id,
           MAX(CASE WHEN src = 'linked' THEN 1 ELSE 0 END) as linked
    FROM (
      SELECT id, name, table_name, project_id, 'tier' as src
        FROM databases WHERE org_id = ? AND project_id IS NULL
      UNION ALL
      SELECT id, name, table_name, project_id, 'tier' as src
        FROM databases WHERE org_id = ? AND project_id = ?
      UNION ALL
      SELECT d.id, d.name, d.table_name, d.project_id, 'linked' as src
        FROM job_databases jd JOIN databases d ON jd.database_id = d.id
        WHERE jd.job_id = ?
    )
    GROUP BY id
  `).all(scope.org_id, scope.org_id, scope.project_id, jobId) as Row[];

  // Resolve name collisions by precedence: job-linked > project-level >
  // org-level. Rank each row, then keep the highest rank per logical name.
  const rank = (r: Row) => (r.linked ? 2 : r.project_id ? 1 : 0);
  const byName = new Map<string, Row>();
  for (const r of rows) {
    const existing = byName.get(r.name);
    if (!existing || rank(r) > rank(existing)) byName.set(r.name, r);
  }
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(r => ({ name: r.name, table_name: r.table_name }));
}

// --- Job Linkage ---

export function linkDatabaseToJob(jobId: string, databaseId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO job_databases (job_id, database_id) VALUES (?, ?)`).run(jobId, databaseId);
}

export function unlinkDatabaseFromJob(jobId: string, databaseId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_databases WHERE job_id = ? AND database_id = ?`).run(jobId, databaseId);
}

export function getJobsForDatabase(databaseId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT j.id, j.name FROM job_databases jd
    JOIN jobs j ON jd.job_id = j.id
    WHERE jd.database_id = ?
  `).all(databaseId);
}

