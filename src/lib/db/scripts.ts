import { v4 as uuid } from "uuid";
import { getDb } from "./schema";

/**
 * Per-job script files. Today the runner runs each command (workflow_command,
 * prerun_command, postrun_command) with `bash -c <cmd>` from a flat
 * `$HARBOUR_HOME/workflows` cwd; the script files were hand-placed by the
 * operator. With job_scripts the file *content* lives in SQLite, is delivered
 * in the /next run payload, and is materialized to disk by the runner into the
 * job's scripts_dir (see buildRunPayload) right before the command runs.
 *
 * Filenames are bare names referenced by the unchanged command strings
 * (e.g. `python3 check_health.py`, `./prerun.sh`) — never paths, so a script
 * can never escape the job's scripts_dir.
 */

/** Allowed script filename shape: bare names only, no path separators. */
const FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validate a script filename. Bare names only: matches FILENAME_RE and is
 * neither "." nor ".." (which would resolve to a directory, not a file).
 * Rejecting slashes means a filename can never traverse out of the job's
 * scripts_dir. Throws a plain Error (house convention — routes map it to 400)
 * on anything invalid; returns the name unchanged when valid.
 */
export function validateScriptFilename(name: string): string {
  if (!FILENAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(
      `Invalid script filename "${name}": use 1-128 of [A-Za-z0-9._-] with no slashes`,
    );
  }
  return name;
}

export type JobScript = {
  id: string;
  job_id: string;
  filename: string;
  content: string;
  executable: number;
  created_at: number;
  updated_at: number;
};

export function listJobScripts(jobId: string): JobScript[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM job_scripts WHERE job_id = ? ORDER BY filename ASC`)
    .all(jobId) as JobScript[];
}

export function getJobScriptById(scriptId: string): JobScript | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM job_scripts WHERE id = ?`).get(scriptId) as JobScript) || null;
}

export function createJobScript(data: {
  jobId: string;
  filename: string;
  content?: string;
  executable?: boolean;
}): JobScript {
  const db = getDb();
  const filename = validateScriptFilename(data.filename);
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO job_scripts (id, job_id, filename, content, executable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, data.jobId, filename, data.content ?? "", data.executable === false ? 0 : 1, now, now);
  return getJobScriptById(id)!;
}

export function updateJobScript(
  scriptId: string,
  data: { filename?: string; content?: string; executable?: boolean },
): JobScript | null {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (data.filename !== undefined) {
    fields.push("filename = ?");
    values.push(validateScriptFilename(data.filename));
  }
  if (data.content !== undefined) {
    fields.push("content = ?");
    values.push(data.content);
  }
  if (data.executable !== undefined) {
    fields.push("executable = ?");
    values.push(data.executable ? 1 : 0);
  }
  if (fields.length === 0) return getJobScriptById(scriptId);

  fields.push("updated_at = unixepoch()");
  db.prepare(`UPDATE job_scripts SET ${fields.join(", ")} WHERE id = ?`).run(...values, scriptId);
  return getJobScriptById(scriptId);
}

export function deleteJobScript(scriptId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM job_scripts WHERE id = ?`).run(scriptId);
}

/**
 * A job's scripts in the shape carried by the /next run payload's job block:
 * `{ filename, content, executable }` with executable coerced to a boolean.
 * Empty array when the job has no scripts (backward-compatible flat-cwd run).
 */
export function getJobScriptsForPayload(
  jobId: string,
): { filename: string; content: string; executable: boolean }[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT filename, content, executable FROM job_scripts WHERE job_id = ? ORDER BY filename ASC`,
      )
      .all(jobId) as { filename: string; content: string; executable: number }[]
  ).map((s) => ({ filename: s.filename, content: s.content, executable: !!s.executable }));
}
