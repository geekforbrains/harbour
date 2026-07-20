import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

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

export type TableMeta = {
  id: string;
  project_id: string;
  name: string;
  table_name: string;
  pinned: number;
  created_at: number;
  updated_at: number;
};

// --- Sanitization ---

const RESERVED = new Set([
  "abort",
  "action",
  "add",
  "after",
  "all",
  "alter",
  "always",
  "analyze",
  "and",
  "as",
  "asc",
  "attach",
  "autoincrement",
  "before",
  "begin",
  "between",
  "by",
  "cascade",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "commit",
  "conflict",
  "constraint",
  "create",
  "cross",
  "current",
  "current_date",
  "current_time",
  "current_timestamp",
  "database",
  "default",
  "deferrable",
  "deferred",
  "delete",
  "desc",
  "detach",
  "distinct",
  "do",
  "drop",
  "each",
  "else",
  "end",
  "escape",
  "except",
  "exclude",
  "exclusive",
  "exists",
  "explain",
  "fail",
  "filter",
  "first",
  "following",
  "for",
  "foreign",
  "from",
  "full",
  "glob",
  "group",
  "groups",
  "having",
  "if",
  "ignore",
  "immediate",
  "in",
  "index",
  "indexed",
  "initially",
  "inner",
  "insert",
  "instead",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "key",
  "last",
  "left",
  "like",
  "limit",
  "match",
  "materialized",
  "natural",
  "no",
  "not",
  "nothing",
  "notnull",
  "null",
  "nulls",
  "of",
  "offset",
  "on",
  "or",
  "order",
  "others",
  "outer",
  "over",
  "partition",
  "plan",
  "pragma",
  "preceding",
  "primary",
  "query",
  "raise",
  "range",
  "recursive",
  "references",
  "regexp",
  "reindex",
  "release",
  "rename",
  "replace",
  "restrict",
  "returning",
  "right",
  "rollback",
  "row",
  "rows",
  "savepoint",
  "select",
  "set",
  "table",
  "temp",
  "temporary",
  "then",
  "ties",
  "to",
  "transaction",
  "trigger",
  "unbounded",
  "union",
  "unique",
  "update",
  "using",
  "vacuum",
  "values",
  "view",
  "virtual",
  "when",
  "where",
  "window",
  "with",
  "without",
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
  return `t_${sanitizeName(name)}`;
}

// Validate a column name for use in dynamic SQL
function safeColumnName(name: string): string {
  const clean = sanitizeName(name);
  if (clean === "_id") throw new Error('Column name "_id" is reserved');
  return clean;
}

// --- Table CRUD ---

export function createTable(
  projectId: string,
  name: string,
  columns: ColumnDef[],
): TableMeta & { columns: ColumnInfo[] } {
  const db = getDb();
  const id = uuid();
  const safeName = sanitizeName(name);
  // Suffix the physical table name with a short slice of the id so the same
  // logical name can exist in different projects without colliding on the
  // globally-unique table_name.
  const tableName = `${toTableName(name)}_${id.replace(/-/g, "").slice(0, 8)}`;

  // Validate columns
  if (!columns.length) throw new Error("At least one column is required");
  const colDefs = columns.map((c) => {
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
    db.prepare(`INSERT INTO tables (id, project_id, name, table_name) VALUES (?, ?, ?, ?)`).run(
      id,
      projectId,
      safeName,
      tableName,
    );

    db.exec(createSql);

    // Record as migration v1
    db.prepare(
      `INSERT INTO table_migrations (id, table_id, version, description, sql) VALUES (?, ?, 1, ?, ?)`,
    ).run(uuid(), id, "Create table", createSql);
  })();

  return getTableById(id)!;
}

export function getTableById(id: string): (TableMeta & { columns: ColumnInfo[] }) | null {
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(id) as TableMeta | undefined;
  if (!meta) return null;
  const columns = db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[];
  return { ...meta, columns: columns.filter((c) => c.name !== "_id") };
}

/** Resolve a table by logical name within a project. */
export function getTableByName(
  projectId: string,
  name: string,
): (TableMeta & { columns: ColumnInfo[] }) | null {
  const db = getDb();
  const safeName = sanitizeName(name);
  const meta = db
    .prepare(`SELECT * FROM tables WHERE project_id = ? AND name = ?`)
    .get(projectId, safeName) as TableMeta | undefined;
  if (!meta) return null;
  const columns = db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[];
  return { ...meta, columns: columns.filter((c) => c.name !== "_id") };
}

/**
 * List tables — one project's when projectId is given, all projects' otherwise.
 * Pinned tables sort first (parity with docs/secrets).
 */
export function listTables(projectId?: string) {
  const db = getDb();
  const metas = db
    .prepare(`
    SELECT t.*, p.name as project_name
    FROM tables t
    JOIN projects p ON t.project_id = p.id
    ${projectId ? "WHERE t.project_id = ?" : ""}
    ORDER BY t.pinned DESC, t.name ASC
  `)
    .all(...(projectId ? [projectId] : [])) as (TableMeta & { project_name: string })[];

  return metas.map((meta) => {
    const count = db.prepare(`SELECT COUNT(*) as count FROM "${meta.table_name}"`).get() as {
      count: number;
    };
    const jobs = db
      .prepare(`
      SELECT j.id, j.name FROM job_tables jt
      JOIN jobs j ON jt.job_id = j.id
      WHERE jt.table_id = ?
    `)
      .all(meta.id) as { id: string; name: string }[];
    return { ...meta, row_count: count.count, jobs };
  });
}

export function deleteTable(id: string) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM tables WHERE id = ?`).get(id) as
    | { table_name: string }
    | undefined;
  if (!meta) return;

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS "${meta.table_name}"`);
    db.prepare(`DELETE FROM tables WHERE id = ?`).run(id);
  })();
}

/**
 * Toggle a table's `pinned` flag. Pinning is a dashboard creation-time default
 * for new jobs (the server links resources explicitly); mirrors docs and secrets.
 */
export function toggleTablePinned(id: string) {
  const db = getDb();
  db.prepare(
    `UPDATE tables SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?`,
  ).run(id);
  return getTableById(id);
}

// --- Schema Operations ---

export function addColumn(tableId: string, column: ColumnDef) {
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(tableId) as
    | TableMeta
    | undefined;
  if (!meta) throw new Error("Table not found");

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

  const version =
    (
      db
        .prepare(`SELECT MAX(version) as v FROM table_migrations WHERE table_id = ?`)
        .get(tableId) as { v: number }
    )?.v || 0;

  db.transaction(() => {
    db.exec(alterSql);
    db.prepare(
      `INSERT INTO table_migrations (id, table_id, version, description, sql) VALUES (?, ?, ?, ?, ?)`,
    ).run(uuid(), tableId, version + 1, `Add column: ${colName}`, alterSql);
    db.prepare(`UPDATE tables SET updated_at = unixepoch() WHERE id = ?`).run(tableId);
  })();

  return getTableById(tableId);
}

export function getTableMigrations(tableId: string) {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM table_migrations WHERE table_id = ? ORDER BY version ASC`)
    .all(tableId);
}

// --- Row Operations ---

export function getRows(
  tableId: string,
  opts?: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    order?: "ASC" | "DESC";
  },
) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM tables WHERE id = ?`).get(tableId) as
    | { table_name: string }
    | undefined;
  if (!meta) return null;

  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  let sql = `SELECT * FROM "${meta.table_name}"`;

  if (opts?.orderBy) {
    // Validate orderBy against actual column names
    const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).map(
      (c) => c.name,
    );
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

  const count = db.prepare(`SELECT COUNT(*) as count FROM "${meta.table_name}"`).get() as {
    count: number;
  };

  return { rows, total: count.count, limit, offset };
}

export function insertRows(tableId: string, rows: Record<string, any>[]) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM tables WHERE id = ?`).get(tableId) as
    | { table_name: string }
    | undefined;
  if (!meta) throw new Error("Table not found");
  if (!rows.length) return { inserted: 0 };

  // Get column info to validate
  const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).filter(
    (c) => c.name !== "_id",
  );
  const validCols = new Set(columns.map((c) => c.name));

  let inserted = 0;
  db.transaction(() => {
    for (const row of rows) {
      const keys = Object.keys(row).filter((k) => validCols.has(k));
      if (!keys.length) continue;
      const placeholders = keys.map(() => "?").join(", ");
      const colNames = keys.map((k) => `"${k}"`).join(", ");
      db.prepare(`INSERT INTO "${meta.table_name}" (${colNames}) VALUES (${placeholders})`).run(
        ...keys.map((k) => row[k] ?? null),
      );
      inserted++;
    }
    db.prepare(`UPDATE tables SET updated_at = unixepoch() WHERE id = ?`).run(tableId);
  })();

  return { inserted };
}

export function updateRow(tableId: string, rowId: number, data: Record<string, any>) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM tables WHERE id = ?`).get(tableId) as
    | { table_name: string }
    | undefined;
  if (!meta) throw new Error("Table not found");

  const columns = (db.pragma(`table_info("${meta.table_name}")`) as ColumnInfo[]).filter(
    (c) => c.name !== "_id",
  );
  const validCols = new Set(columns.map((c) => c.name));
  const keys = Object.keys(data).filter((k) => validCols.has(k));
  if (!keys.length) throw new Error("No valid columns to update");

  const sets = keys.map((k) => `"${k}" = ?`).join(", ");
  const values = keys.map((k) => data[k] ?? null);

  db.transaction(() => {
    db.prepare(`UPDATE "${meta.table_name}" SET ${sets} WHERE _id = ?`).run(...values, rowId);
    db.prepare(`UPDATE tables SET updated_at = unixepoch() WHERE id = ?`).run(tableId);
  })();

  return db.prepare(`SELECT * FROM "${meta.table_name}" WHERE _id = ?`).get(rowId);
}

export function deleteRow(tableId: string, rowId: number) {
  const db = getDb();
  const meta = db.prepare(`SELECT table_name FROM tables WHERE id = ?`).get(tableId) as
    | { table_name: string }
    | undefined;
  if (!meta) throw new Error("Table not found");

  db.transaction(() => {
    db.prepare(`DELETE FROM "${meta.table_name}" WHERE _id = ?`).run(rowId);
    db.prepare(`UPDATE tables SET updated_at = unixepoch() WHERE id = ?`).run(tableId);
  })();
}

/**
 * Tables injected into a job's run payload (used by buildRunPayload / the
 * runner claim payload): pinned tables from the job's own project first, then
 * tables explicitly linked via `job_tables` (any project) in link-creation
 * order — on a logical-name collision the later assignment wins. The payload
 * exposes only `name` + `id` (no columns, no rows) — the agent reads/writes
 * contents on demand via the table API using the id.
 */
export function getComposedTablesForJob(jobId: string): { id: string; name: string }[] {
  const db = getDb();
  type Row = { id: string; name: string };

  const pinned = db
    .prepare(`
    SELECT id, name FROM tables
    WHERE pinned = 1 AND project_id = (SELECT project_id FROM jobs WHERE id = ?)
    ORDER BY name ASC
  `)
    .all(jobId) as Row[];
  const linked = db
    .prepare(`
    SELECT t.id, t.name
    FROM job_tables jt
    JOIN tables t ON t.id = jt.table_id
    WHERE jt.job_id = ?
    ORDER BY jt.rowid ASC
  `)
    .all(jobId) as Row[];

  const byName = new Map<string, Row>();
  for (const table of [...pinned, ...linked]) byName.set(table.name, table);
  return [...byName.values()];
}

// --- Job Linkage ---

export function linkTableToJob(jobId: string, tableId: string) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO job_tables (job_id, table_id) VALUES (?, ?)`).run(
    jobId,
    tableId,
  );
}

export function unlinkTableFromJob(jobId: string, tableId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_tables WHERE job_id = ? AND table_id = ?`).run(jobId, tableId);
}

export function getJobsForTable(tableId: string) {
  const db = getDb();
  return db
    .prepare(`
    SELECT j.id, j.name FROM job_tables jt
    JOIN jobs j ON jt.job_id = j.id
    WHERE jt.table_id = ?
  `)
    .all(tableId);
}
