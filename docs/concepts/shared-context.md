# Shared context: docs, databases, env vars

Three top-level entities — markdown documents, agent-managed SQLite tables, and encrypted key-value pairs — that share one job: get the right context into a run without the agent having to ask. They're discussed together because the contract is the same:

- They belong to an **org** (`org_id`), optionally narrowed to a **project** (`project_id` is nullable — `NULL` means org-level, usable by every project in the org). See [Orgs & projects](projects.md).
- They're **linked to a job** via three identical junction tables: `job_docs`, `job_databases`, `job_env_vars`.
- They're **injected into `/next`** when an agent polls — docs as content, databases as recent rows, secrets as a decrypted map.
- Two of them (docs and secrets) support **pinning** for "auto-attach to all new jobs."

The differences are in *what* gets injected. Docs are full text. Databases are the last 100 rows of each linked table. Secrets are decrypted only at the moment of polling and never stored in plaintext.

(The UI labels env vars **Secrets**; the table is still `env_vars`.)

## A worked example

A `Marketing` agent has one job — "Daily content calendar update":

```
Linked docs:        Brand voice (pinned), Style guide
Linked databases:   marketing_calendar
Linked env vars:    BUFFER_API_KEY (pinned)
```

The agent polls `GET /api/agents/<id>/next`. The response bundles:

```json
{
  "run":  { "id": "...", "status": "running" },
  "job":  { "instructions": "...", "..." },
  "docs": [
    { "title": "Brand voice", "content": "...full markdown..." },
    { "title": "Style guide", "content": "...full markdown..." }
  ],
  "data": {
    "marketing_calendar": [ /* up to 100 most recent rows */ ]
  },
  "env": {
    "BUFFER_API_KEY": "decrypted-secret-here"
  },
  "api": { "endpoints": { "..." } }
}
```

The agent writes a draft, posts it to Buffer using the env var, inserts a row into `marketing_calendar`, sets status to `done`. Tomorrow's run sees the new row in `data.marketing_calendar` because the table is the same one the agent just wrote to — the latest 100 always come back on the next poll.

## Pinning

Pinning is the answer to "I just made a new thing — apply this context everywhere automatically." Both docs and env vars support it.

The crucial detail: **pinning is checked at creation time only**. When you call `createJob` (or `createOneOffRun`) the code merges your explicitly-selected ids with `listPinnedDocIds()` and `listPinnedEnvVarIds()` and inserts both sets into the junction tables. After that, the link is just a row in `job_docs` / `job_env_vars` like any other.

What this means in practice:

| Action | Effect |
|---|---|
| Pin a doc, then create a new job | Job gets the doc linked. |
| Create a job, then pin a doc | Existing job is **not** updated. New jobs created after the pin will get it. |
| Unpin a doc that was pinned | Existing junction rows stay. Future creations don't include it. |
| Delete the doc | Cascade-deletes the junction rows. Vanishes from existing jobs too (but only because the doc itself is gone). |

Treat pinning as a default for *new* things, not as a live broadcast. If you want a doc applied retroactively, link it to each job manually (or write a one-shot SQL update via Captain).

Databases don't pin. They're heavier — typically you want a job to see only the slice of structured data it cares about, so the explicit linking is the point.

## Docs

Markdown documents, stored revisioned. Each `docs` row has a title and metadata; each edit appends a new `doc_revisions` row with the full content. The latest revision's content is what gets injected into `/next` (resolved with a correlated subquery on `MAX(created_at)`).

(Columns — including the `org_id` / `project_id` dual-tier — in
[database-schema.md](../reference/database-schema.md#docs).)

Agents can create and update docs through `POST /api/docs` and `PUT /api/docs/:id`. Updates are revisions — there's no destructive edit. If an agent maintains a "Daily summary" doc, every day's update is a new row; the dashboard's revision viewer can walk the history.

## Databases

Agent-managed SQLite tables that live in the same `harbour.db` file. The agent calls `POST /api/databases` with a name and column definitions; harbour creates a real table with a sanitized, globally-unique physical name and an auto-incrementing `_id INTEGER PRIMARY KEY` plus the agent's columns.

Two tables track the metadata:

(Columns in [database-schema.md](../reference/database-schema.md#databases).
`databases`/`database_migrations` are dual-tier like docs and secrets.)

Every schema change (CREATE, ALTER) records a `database_migrations` row, so the dashboard can show the schema's history.

The injection rule for `/next`: for each linked database, harbour runs `SELECT * FROM "<table>" ORDER BY rowid DESC LIMIT 100` and stuffs the result into `data.<name>`. That's intentionally simple — agents that need older data or filtered views call `GET /api/databases/:id/rows` directly with `?limit=` and `?offset=`.

Reserved-word and SQL-injection guards: column names are sanitized identically (lowercase, `[a-z0-9_]`, no `_id`), and a list of SQLite reserved words is rejected outright. Inserts validate the keys against `PRAGMA table_info` before running. Don't trust an agent's input to be safe; the helpers in `src/lib/db/database.ts` enforce the rules.

## Env vars

Encrypted key-value pairs. Each row has a name, a single `encrypted_value` blob, and a `pinned` flag.

Encryption is AES-256-GCM (`src/lib/encryption.ts`):

| Field | Spec |
|---|---|
| Algorithm | `aes-256-gcm` |
| Key | 32 bytes (64 hex chars) |
| IV | 12 random bytes per write |
| Auth tag | 16 bytes |
| On-disk format | `<iv-hex>:<authTag-hex>:<ciphertext-hex>` (single TEXT column) |
| Key location | `HARBOUR_ENCRYPTION_KEY` env var (preferred) or `~/.harbour/encryption.key` (auto-generated, mode 0600) |

Decryption happens at the boundary — `getDecryptedEnvVarsForJob(jobId)` is called when assembling the `/next` payload, and an explicit `GET /api/env-vars/:id/value` endpoint exists for the dashboard's "reveal value" affordance. List endpoints never include the encrypted blob; you have to ask for a single var by id, and the request is gated by `withResourceAuth` (editor role in the resource's org).

Losing the key (deleting `~/.harbour/encryption.key` without a backup) renders all encrypted_value blobs unreadable. There is no recovery — back the file up, or set `HARBOUR_ENCRYPTION_KEY` from a secrets store.

## Linking

Three identical junction tables, one per kind:

```sql
CREATE TABLE job_docs       (job_id, doc_id,       PRIMARY KEY(job_id, doc_id));
CREATE TABLE job_databases  (job_id, database_id,  PRIMARY KEY(job_id, database_id));
CREATE TABLE job_env_vars   (job_id, env_var_id,   PRIMARY KEY(job_id, env_var_id));
```

All three use `ON DELETE CASCADE` for both sides. Delete a job, the junction rows go. Delete the doc/db/env var, same.

Linking from the dashboard happens through the job edit page. Via API, agent jobs are created under `POST /api/agents/:id/jobs` and workflows under `POST /api/jobs`; a job's docs and secrets are linked or unlinked through `POST` / `DELETE /api/jobs/:id/{docs,env-vars}`. Pinned ids are merged in automatically at create time as described above.

## What's not shared

These three are explicitly not the same thing as **attachments** ([Attachments](attachments.md)), which belong to a single run and are fundamentally per-execution context. Docs/data/env vars are per-job standing context — they're meant to be the same on every run of the job.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/docs.ts` — `createDoc`, `updateDoc` (revisions), `toggleDocPinned`, `listPinnedDocIds`.
- `src/lib/db/database.ts` — `createDatabase`, `addColumn`, `insertRows`, `getRows`, plus the name-sanitization and reserved-word guards.
- `src/lib/db/env-vars.ts` — env var CRUD, `getDecryptedEnvVarsForJob`, `listPinnedEnvVarIds`.
- `src/lib/db/jobs.ts` — `createJob` and `createOneOffRun` are where the pinned ids get merged into the junction inserts.
- `src/lib/db/runs.ts` — `buildRunPayload` (the `/next` payload assembly): docs query, the `LIMIT 100` per-table database query, env decryption.
- `src/lib/encryption.ts` — AES-256-GCM helpers, key loading.
- `src/lib/db/schema.ts` — `docs`, `doc_revisions`, `databases`, `database_migrations`, `env_vars`, and the three `job_*` junction tables.
