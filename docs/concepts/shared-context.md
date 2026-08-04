# Shared context: docs, tables, env vars

Three top-level entities — markdown documents, agent-managed SQLite tables, and encrypted key-value pairs — that share one job: get the right context into a run without the agent having to ask. They're discussed together because the contract is the same:

- They belong to a **project** (`project_id`, NOT NULL). See [Projects](projects.md).
- They're **linked to a job** via three identical junction tables: `job_docs`, `job_tables`, `job_env_vars` — and a link may point at a resource in **any** project, not just the job's own.
- They're **injected into the run payload** when a runner claims the run — when **pinned in the job's own project** or **linked to the job** (project membership alone injects nothing): docs as content, tables as a name+id read reference, secrets as a decrypted map.
- All three support **pinning** — a per-project auto-attach that injects the resource into every run of every job in its project.

The differences are in *what* gets injected. Docs are full text. Tables inject only their `name` + `id` — a read reference the agent dereferences on demand via the API, never inlined rows. Secrets are decrypted only at the moment of polling and never stored in plaintext.

(The UI labels env vars **Secrets**; the table is still `env_vars`.)

## A worked example

A `Marketing` agent has one job — "Daily content calendar update":

```
Linked docs:        Brand voice (pinned), Style guide
Linked tables:      marketing_calendar
Linked env vars:    BUFFER_API_KEY (pinned)
```

When a runner claims the agent's run (`POST /api/runner/claim`), the response bundles everything the run needs:

```json
{
  "run":  { "id": "...", "status": "running" },
  "job":  { "instructions": "...", "..." },
  "docs": [
    { "title": "Brand voice", "content": "...full markdown..." },
    { "title": "Style guide", "content": "...full markdown..." }
  ],
  "tables": {
    "marketing_calendar": { "id": "tbl-uuid" }
  },
  "env": {
    "BUFFER_API_KEY": "decrypted-secret-here"
  },
  "api": { "endpoints": { "..." } }
}
```

The agent writes a draft, posts it to Buffer using the env var, then reads `marketing_calendar` via `GET /api/tables/tbl-uuid/rows` to check what's already scheduled, inserts a row, and sets status to `done`. The table arrives as a reference (`id` only), not inlined rows — the agent pulls exactly the slice it needs on demand.

## Pinning

Pinning is the answer to "apply this context to everything in this project automatically." Docs, tables, and env vars all support it.

**Pinning is a live, project-wide auto-attach.** A pinned resource is injected into the run payload of **every job in its own project**, no link row required. It's resolved at payload-build time (`getComposedDocsForJob` / `getComposedTablesForJob` / `getDecryptedEnvVarsForJob`): pinned resources of the job's own project come first, then the job's explicit links (from any project) in link-creation order — so on a name collision, a linked resource overrides a pinned one. A resource that is both pinned and linked appears once.

Pinning never crosses projects — a pinned doc in project A is invisible to project B's jobs unless a job there links it explicitly. The New Job dialog also pre-checks pinned items in scope as a convenience, but that's cosmetic: pinned resources reach the run either way.

What this means in practice:

| Action | Effect |
|---|---|
| Pin a doc | Every run of every job in the doc's project now carries it — existing jobs included, next run onward. |
| Unpin a doc | It stops being injected (unless a job links it explicitly). Existing junction rows are untouched. |
| Link a same-named secret to a job in another project | The linked value wins over a pinned one on the name collision. |
| Create a job via the API | `docIds` / `envVarIds` / `tableIds` set the explicit links; pinned resources of the job's project are injected regardless. |
| Delete the doc | Gone everywhere — junction rows cascade, and there's nothing left to inject. |

Tables pin like docs and secrets, but reach for it sparingly — they're heavier, and typically you want a job to see only the slice of structured data it cares about, so explicit linking is usually the point.

## Docs

Markdown documents, stored revisioned. Each `docs` row has a title and metadata; each edit appends a new `doc_revisions` row with the full content. The latest revision's content is what gets injected into the run payload (resolved with a correlated subquery on `MAX(created_at)`).

(Columns in [database-schema.md](../reference/database-schema.md#docs).)

Agents can create and update docs through `POST /api/docs` and `PUT /api/docs/:id`. Updates are revisions — there's no destructive edit. If an agent maintains a "Daily summary" doc, every day's update is a new row; the dashboard's revision viewer can walk the history.

## Tables

Agent-managed SQLite tables that live in the same `harbour.db` file. The agent calls `POST /api/tables` with a name and column definitions; harbour creates a real table with a sanitized, globally-unique physical name and an auto-incrementing `_id INTEGER PRIMARY KEY` plus the agent's columns.

Two tables track the metadata:

(Columns in [database-schema.md](../reference/database-schema.md#tables).)

Every schema change (CREATE, ALTER) records a `table_migrations` row, so the dashboard can show the schema's history.

The injection rule for the run payload: for each table **pinned in the job's project or linked to the job**, harbour puts `{ id }` into `tables.<name>` — no rows, no columns. A table is a read reference, not inlined content; the agent calls `GET /api/tables/:id/rows` (with `?limit=`/`?offset=`/`?orderBy=`) to read exactly the slice it needs and `POST /api/tables/:id/rows` to write. Project membership alone does not inject a table — it has to be pinned or in `job_tables`.

Reserved-word and SQL-injection guards: column names are sanitized identically (lowercase, `[a-z0-9_]`, no `_id`), and a list of SQLite reserved words is rejected outright. Inserts validate the keys against `PRAGMA table_info` before running. Don't trust an agent's input to be safe; the helpers in `src/lib/db/tables.ts` enforce the rules.

## Env vars

Encrypted key-value pairs. Each row has a name (unique within its project — a duplicate is rejected with "already exists in this project"), a single `encrypted_value` blob, and a `pinned` flag.

Encryption is AES-256-GCM (`src/lib/encryption.ts`):

| Field | Spec |
|---|---|
| Algorithm | `aes-256-gcm` |
| Key | 32 bytes (64 hex chars) |
| IV | 12 random bytes per write |
| Auth tag | 16 bytes |
| On-disk format | `<iv-hex>:<authTag-hex>:<ciphertext-hex>` (single TEXT column) |
| Key location | `HARBOUR_ENCRYPTION_KEY` env var (preferred) or `~/.harbour/encryption.key` (auto-generated, mode 0600) |

Decryption happens at the boundary — `getDecryptedEnvVarsForJob(jobId)` is called when assembling the run payload and decrypts the pinned/linked values. An explicit `GET /api/env-vars/:id/value` endpoint exists for the dashboard's "reveal value" affordance (any authenticated user; agents can't call it). List endpoints never include the encrypted blob; you have to ask for a single var by id.

Losing the key (deleting `~/.harbour/encryption.key` without a backup) renders all encrypted_value blobs unreadable. There is no recovery — back the file up, or set `HARBOUR_ENCRYPTION_KEY` from a secrets store.

## Linking

Three identical junction tables, one per kind:

```sql
CREATE TABLE job_docs       (job_id, doc_id,       PRIMARY KEY(job_id, doc_id));
CREATE TABLE job_tables     (job_id, table_id,     PRIMARY KEY(job_id, table_id));
CREATE TABLE job_env_vars   (job_id, env_var_id,   PRIMARY KEY(job_id, env_var_id));
```

All three junction tables use `ON DELETE CASCADE` for both sides. Delete a job, the junction rows go. Delete the doc/table/env var, same.

Linking from the dashboard happens through the job edit page. Via API, agent jobs are created under `POST /api/agents/:id/jobs` and workflows under `POST /api/jobs`; a job's docs, secrets, and tables are linked or unlinked through `POST` / `DELETE /api/jobs/:id/{docs,env-vars,tables}`. Links are unrestricted across projects — a job may link a resource from any project — and re-linking an already-linked resource is a no-op (`INSERT OR IGNORE`). Pinned resources of the job's own project need no link at all — see Pinning above.

## What's not shared

These three are explicitly not the same thing as **attachments** ([Attachments](attachments.md)), which belong to a single run and are fundamentally per-execution context. Docs/tables/env vars are per-job standing context — they're meant to be the same on every run of the job.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/docs.ts` — `createDoc`, `updateDoc` (revisions), `toggleDocPinned`.
- `src/lib/db/tables.ts` — `createTable`, `addColumn`, `insertRows`, `getRows`, plus the name-sanitization and reserved-word guards.
- `src/lib/db/env-vars.ts` — env var CRUD, `getDecryptedEnvVarsForJob` (pinned-then-linked merge, linked wins).
- `src/lib/db/jobs.ts` — `createJob` / `createWorkflow` link exactly the ids passed in; `triggerJobRun` is the ad-hoc-run path (it reuses an existing job's links).
- `src/lib/db/runs.ts` — `buildRunPayload` (the run payload assembly): the composition queries (`getComposedDocsForJob`, `getComposedTablesForJob` → name+id only, `getDecryptedEnvVarsForJob`), each merging the project's pinned resources with the job's `job_*` links.
- `src/lib/encryption.ts` — AES-256-GCM helpers, key loading.
- `src/lib/db/schema.ts` — `docs`, `doc_revisions`, `tables`, `table_migrations`, `env_vars`, and the three `job_*` junction tables.
