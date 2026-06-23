# Shared context: docs, tables, env vars

Three top-level entities — markdown documents, agent-managed SQLite tables, and encrypted key-value pairs — that share one job: get the right context into a run without the agent having to ask. They're discussed together because the contract is the same:

- They belong to an **org** (`org_id`), optionally narrowed to a **project** (`project_id` is nullable — `NULL` means org-level, usable by every project in the org). See [Orgs & projects](projects.md).
- They're **linked to a job** via three identical junction tables: `job_docs`, `job_tables`, `job_env_vars`.
- They're **injected into the run payload** when a runner claims the run — but only when **linked to the job** (org/project membership alone injects nothing): docs as content, tables as a name+id read reference, secrets as a decrypted map.
- All three support **pinning** — a creation-time default that pre-selects them for new jobs.

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

Pinning is the answer to "I just made a new thing — apply this context everywhere automatically." Docs, tables, and env vars all support it.

The crucial detail: **pinning is a creation-time default, not a live link.** It's a dashboard convenience — the **New Job** dialog pre-checks every pinned doc/table/secret in scope so a new job picks them up by default. The job is created with exactly the set you submit: keep the pre-checked items and they're linked; deselect one and it is **not** linked. The server attaches only what the request carries (`createJob` / `createWorkflow` are explicit, matching `updateJob`) — pinning has no server-side effect of its own. After creation, each link is just a row in `job_docs` / `job_tables` / `job_env_vars` like any other; an ad-hoc run via `triggerJobRun` fires an existing job whose links were resolved at creation.

What this means in practice:

| Action | Effect |
|---|---|
| Pin a doc, then create a new job in the dashboard | Dialog pre-checks it → job gets the doc linked. |
| Deselect a pre-checked pinned doc in the New Job dialog | Job is created **without** it — the deselection is honored. |
| Create a job, then pin a doc | Existing job is **not** updated. New jobs created after the pin pre-check it. |
| Unpin a doc that was pinned | Existing junction rows stay. Future creations don't pre-check it. |
| Create a job via the API | Pinning is ignored — the API links exactly the `docIds` / `envVarIds` / `tableIds` you pass. |
| Delete the doc | Cascade-deletes the junction rows. Vanishes from existing jobs too (but only because the doc itself is gone). |

Treat pinning as a default for *new* things created in the dashboard, not as a live broadcast. If you want a doc applied to an existing job, link it explicitly (the job's detail page, or `POST /api/jobs/:id/docs`).

Tables pin like docs and secrets, but reach for it sparingly — they're heavier, and typically you want a job to see only the slice of structured data it cares about, so explicit linking is usually the point.

## Docs

Markdown documents, stored revisioned. Each `docs` row has a title and metadata; each edit appends a new `doc_revisions` row with the full content. The latest revision's content is what gets injected into the run payload (resolved with a correlated subquery on `MAX(created_at)`).

(Columns — including the `org_id` / `project_id` dual-tier — in
[database-schema.md](../reference/database-schema.md#docs).)

Agents can create and update docs through `POST /api/docs` and `PUT /api/docs/:id`. Updates are revisions — there's no destructive edit. If an agent maintains a "Daily summary" doc, every day's update is a new row; the dashboard's revision viewer can walk the history.

## Tables

Agent-managed SQLite tables that live in the same `harbour.db` file. The agent calls `POST /api/tables` with a name and column definitions; harbour creates a real table with a sanitized, globally-unique physical name and an auto-incrementing `_id INTEGER PRIMARY KEY` plus the agent's columns.

Two tables track the metadata:

(Columns in [database-schema.md](../reference/database-schema.md#tables).
`tables`/`table_migrations` are dual-tier like docs and secrets.)

Every schema change (CREATE, ALTER) records a `table_migrations` row, so the dashboard can show the schema's history.

The injection rule for the run payload: for each **linked** table, harbour puts `{ id }` into `tables.<name>` — no rows, no columns. A table is a read reference, not inlined content; the agent calls `GET /api/tables/:id/rows` (with `?limit=`/`?offset=`/`?orderBy=`) to read exactly the slice it needs and `POST /api/tables/:id/rows` to write. Org/project membership alone does not inject a table — only an entry in `job_tables` does.

Reserved-word and SQL-injection guards: column names are sanitized identically (lowercase, `[a-z0-9_]`, no `_id`), and a list of SQLite reserved words is rejected outright. Inserts validate the keys against `PRAGMA table_info` before running. Don't trust an agent's input to be safe; the helpers in `src/lib/db/tables.ts` enforce the rules.

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

Decryption happens at the boundary — `getDecryptedEnvVarsForJob(jobId)` is called when assembling the run payload, and an explicit `GET /api/env-vars/:id/value` endpoint exists for the dashboard's "reveal value" affordance. List endpoints never include the encrypted blob; you have to ask for a single var by id, and the request is gated by `withResourceAuth` (editor role in the resource's org).

Losing the key (deleting `~/.harbour/encryption.key` without a backup) renders all encrypted_value blobs unreadable. There is no recovery — back the file up, or set `HARBOUR_ENCRYPTION_KEY` from a secrets store.

## Linking

Three identical junction tables, one per kind:

```sql
CREATE TABLE job_docs       (job_id, doc_id,       PRIMARY KEY(job_id, doc_id));
CREATE TABLE job_tables     (job_id, table_id,     PRIMARY KEY(job_id, table_id));
CREATE TABLE job_env_vars   (job_id, env_var_id,   PRIMARY KEY(job_id, env_var_id));
```

All three use `ON DELETE CASCADE` for both sides. Delete a job, the junction rows go. Delete the doc/table/env var, same.

Linking from the dashboard happens through the job edit page. Via API, agent jobs are created under `POST /api/agents/:id/jobs` and workflows under `POST /api/jobs`; a job's docs, secrets, and tables are linked or unlinked through `POST` / `DELETE /api/jobs/:id/{docs,env-vars,tables}`. The dashboard pre-selects pinned ids as a creation-time default (you can deselect them); the API links only the ids you pass — see Pinning above.

## What's not shared

These three are explicitly not the same thing as **attachments** ([Attachments](attachments.md)), which belong to a single run and are fundamentally per-execution context. Docs/tables/env vars are per-job standing context — they're meant to be the same on every run of the job.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/docs.ts` — `createDoc`, `updateDoc` (revisions), `toggleDocPinned`.
- `src/lib/db/tables.ts` — `createTable`, `addColumn`, `insertRows`, `getRows`, plus the name-sanitization and reserved-word guards.
- `src/lib/db/env-vars.ts` — env var CRUD, `getDecryptedEnvVarsForJob` (project-over-org override).
- `src/lib/db/jobs.ts` — `createJob` / `createWorkflow` link exactly the ids passed in (no pinned merge — pinning is a dashboard default); `triggerJobRun` is the ad-hoc-run path (it reuses an existing job's links).
- `src/lib/db/runs.ts` — `buildRunPayload` (the run payload assembly): attachment-driven docs/tables/env queries (`getComposedDocsForJob`, `getComposedTablesForJob` → name+id only, `getDecryptedEnvVarsForJob`), all reading the `job_*` junction tables.
- `src/lib/encryption.ts` — AES-256-GCM helpers, key loading.
- `src/lib/db/schema.ts` — `docs`, `doc_revisions`, `tables`, `table_migrations`, `env_vars`, and the three `job_*` junction tables.
