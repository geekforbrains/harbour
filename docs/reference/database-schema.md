# Database schema

One SQLite file (default `~/.harbour/harbour.db`), `journal_mode = WAL`,
`foreign_keys = ON`, `busy_timeout = 5000`. **Source of truth:
`src/lib/db/schema.ts`** (`initializeSchema`). Harbour has no schema migrations —
a drifted database fails startup verification (`verifySchema`) with a precise
diff; a fresh database is the only supported path.

- **21 tables**, **21 explicit indexes** (plus auto-indexes on PK / UNIQUE).
- Timestamps are unix epoch seconds (`unixepoch()` defaults). Booleans are
  INTEGER 0/1. IDs are uuid TEXT **except** `run_output.id`, which is an
  AUTOINCREMENT integer used as an SSE cursor.

Notation: **PK** / **FK**(cascade) / **NN** / **U** / **CHECK**. Defaults shown
only when non-trivial.

## Shape

The hierarchy is flat: **instance → projects → agents & jobs → runs**, and
every resource (docs / env_vars / tables) belongs to exactly one project:

- Every project-owned table (`agents`, `jobs`, `runs`, `docs`, `env_vars`,
  `tables`) carries a **NOT NULL** `project_id` FK with `ON DELETE CASCADE` —
  deleting a project is a **hard cascade delete** of everything beneath it
  (there is no `archived_at` / soft delete). Runner workspace directories on
  runner machines are **never auto-removed**; a deleted project leaves its
  workspace dirs behind.
- `runs.project_id` is denormalized (copied from the job) so project-scoped run
  queries need no join.
- The `runners` registry and the `settings` KV are **instance-level**.
- There are no tenancy tables: no orgs, no memberships, no roles. `users` has
  no admin flag — every authenticated user may do everything.

## Slugs

`projects` and `agents` each carry a `slug` (TEXT NN) — the filesystem-safe
workspace path segment runners use to nest workspaces as
`<project-slug>/<agent-slug>`. Semantics (algorithm in `src/lib/slug.ts`,
enforcement in the create paths of the query layer):

- **Assigned at creation** from the name (lowercase; runs of non-`[a-z0-9]`
  collapse to a single `-`; trimmed). A name that slugifies to `""` is rejected.
- **Immutable on rename** — workspace paths stay stable.
- **Unique per scope**, enforced by unique indexes: project slugs
  instance-wide (`idx_projects_slug`), agent slugs per project
  (`idx_agents_project_slug`).

## Identity

### `users`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | uuid |
| `email` | TEXT | NN, U | |
| `password_hash` | TEXT | | argon2id; **NULLABLE** — created without one until a set-password link is consumed |
| `display_name` | TEXT | NN | |
| `created_at` / `updated_at` | INTEGER | NN | |

No role or admin columns — authentication is the whole story.

### `sessions`
Cookie-backed user sessions. `id` is the `harbour_session` cookie value.
`user_id` (FK → users, CASCADE), `expires_at`, `created_at`. Index:
`idx_sessions_user`.

### `set_password_tokens`
Single-use invite / reset links.
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `token_hash` | TEXT | NN, U | sha256 of `base64url(randomBytes(32))` |
| `user_id` | TEXT | NN, FK → `users` (CASCADE) | |
| `created_by_user_id` | TEXT | FK → `users` (SET NULL) | |
| `expires_at` | INTEGER | NN | 24h TTL |
| `consumed_at` | INTEGER | | single-use; consumed atomically in a txn |
| `created_at` | INTEGER | NN | |

The `token_hash` UNIQUE constraint supplies its lookup index.

### `api_keys`
Bearer keys (`hbr_` + 64 hex chars) that resolve to the **creator's** user
identity.
`id`, `name`, `api_key_hash` (NN, U — sha256), `created_by_user_id` (NN, FK →
users CASCADE), `last_used_at`, timestamps.

## Hierarchy

### `projects`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | NN | |
| `slug` | TEXT | NN | unique instance-wide; creation-time, immutable workspace path segment (see [Slugs](#slugs)) |
| `created_at` / `updated_at` | INTEGER | NN | |

Index: `idx_projects_slug(slug)` (UNIQUE). DELETE is a hard cascade — every
agent, job, run, doc, secret, and table under the project goes with it.

## Operational entities

### `agents`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `project_id` | TEXT | NN, FK → `projects` (CASCADE) | |
| `name` | TEXT | NN | |
| `slug` | TEXT | NN | unique per project; creation-time, immutable workspace path segment (see [Slugs](#slugs)) |
| `description` | TEXT | | |
| `cli` | TEXT | | `claude` / `codex` — required by the create API (every agent is CLI-driven) |
| `model` / `thinking` | TEXT | | default model + effort override |
| `color` | TEXT | | stored identity hue (user-selectable; name-hash fallback when null) |
| `eager` | INTEGER | NN, default 0 | legacy/no-op — the pool drains all due work each cycle regardless (kept for compatibility) |
| `placement` | TEXT | NN, default `'local'` | routes this agent's runs to a runner tier/label (denormalized onto `runs.placement` at creation) |
| `created_at` / `updated_at` | INTEGER | NN | |

There is no stored `type` column — every agent is CLI-driven and claimed by the
unified runner (routed via `placement` + the `runners` registry, not per-agent
config). Index: `idx_agents_project_slug(project_id, slug)` (UNIQUE).

### `runners`
The **instance-level runner registry** — one row per runner (the auto-provisioned
local runner plus any remote runners).
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | NN | |
| `token_hash` | TEXT | NN, U | sha256 of the bearer token (`hbrn_…`) |
| `tier` | TEXT | NN, CHECK in (`local`, `remote`) | local = trusted/unscoped; remote = scoped |
| `labels` | TEXT | NN, default `'[]'` | JSON: placement labels this token is **authorized** to serve |
| `capabilities` | TEXT | | JSON `{kinds,clis,labels}` — last-**advertised** host capabilities (health/display) |
| `scope` | TEXT | | JSON `{agentId?}` or NULL (unscoped — local tier) |
| `last_polled_at` | INTEGER | | updated on every claim/peek; drives the health surface |
| `created_at` / `updated_at` | INTEGER | NN | |

The `token_hash` UNIQUE constraint supplies its lookup index.

### `jobs`
Static configuration for recurring work (agent or workflow).
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `project_id` | TEXT | NN, FK → `projects` (CASCADE) | |
| `kind` | TEXT | NN, default `agent`, CHECK in (`agent`, `workflow`) | |
| `agent_id` | TEXT | FK → `agents` (CASCADE) | set for agent jobs, **NULL for workflow jobs** |
| `name` / `description` / `instructions` | TEXT | | `instructions` is the agent prompt body |
| `schedule` | TEXT | NN | normalized JSON: `{"every":N}` or `{"days":[0-6],"time":"HH:MM"}` |
| `prerun_runtime` | TEXT | CHECK NULL or in (`bash`, `python`, `node`) | runtime for the prerun gist; NULL exactly when `prerun_script` is |
| `prerun_script` | TEXT | | agent gate body: exit 0 continues, 77 skips, other fails |
| `postrun_runtime` | TEXT | CHECK NULL or in (`bash`, `python`, `node`) | runtime for the postrun gist; NULL exactly when `postrun_script` is |
| `postrun_script` | TEXT | | post-agent hook body, runs after status finalization |
| `postrun_gates` | INTEGER | NN, default 0 | 0 = informational (never changes status); 1 = enforcing (nonzero overrides `done`→`failed`) |
| `workflow_runtime` | TEXT | CHECK NULL or in (`bash`, `python`, `node`) | runtime for the workflow gist; NULL exactly when `workflow_script` is |
| `workflow_script` | TEXT | | workflow job command body (no agent / LLM) |
| `placement` | TEXT | NN, default `'local'` | workflow jobs: routes runs to a runner tier/label (agent jobs inherit from their agent) |
| `timeout_minutes` | INTEGER | NN, default 30 | |
| `model` / `thinking` | TEXT | | per-job override |
| `title_format` | TEXT | | hint for how agents name runs |
| `active` | INTEGER | NN, default 1 | |
| `last_run_at` / `next_run_at` | INTEGER | | schedule advance |
| `created_at` / `updated_at` | INTEGER | NN | |

Indexes: `idx_jobs_project`, `idx_jobs_agent`,
`idx_jobs_schedule(kind, agent_id, active, next_run_at)`.

### `runs`
A single execution of a job.
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `project_id` | TEXT | NN, FK → `projects` (CASCADE) | denormalized from the job |
| `job_id` | TEXT | NN, FK → `jobs` (CASCADE) | |
| `agent_id` | TEXT | FK → `agents` (SET NULL) | NULL for workflow runs |
| `status` | TEXT | NN, default `running`, CHECK | `scheduled \| running \| waiting \| pending \| done \| failed \| skipped \| killed` |
| `title` | TEXT | | short run title (agent-settable) |
| `placement` | TEXT | NN, default `'local'` | denormalized from the agent (agent runs) or job (workflow runs) at creation; keeps the claim query flat |
| `claimed_by` | TEXT | FK → `runners` (SET NULL) | which runner claimed this run |
| `exec_token_hash` | TEXT | | sha256 of the per-run executor token (`hbx_…`); minted at claim, the CLI's run-scoped callback credential |
| `scheduled_for` | INTEGER | | one-off / triggered runs |
| `claimed_at` | INTEGER | | set when flipped to `running` |
| `completed_at` | INTEGER | | set on terminal status |
| `kill_requested_at` | INTEGER | | dashboard kill trigger |
| `extra_instructions` | TEXT | | trigger-time append |
| `session_id` / `session_cwd` | TEXT | | CLI session + cwd for resume |
| `created_at` / `updated_at` | INTEGER | NN | |

Indexes: `idx_runs_project`, `idx_runs_job`, `idx_runs_agent`,
`idx_runs_status`, `idx_runs_claimed_by`, and the partial `idx_runs_exec_token`.

### `run_activity`
Ordered message log. On workflow runs this is runner output only
(`workflow`/`system` authors), never a conversation.
`id`, `run_id`, `author_type` (NN, CHECK in `agent`/`user`/`system`/`workflow`),
`author_id`, `author_name`, `content`, `created_at`. Indexes:
`idx_run_activity_run_time(run_id, created_at)`.

### `run_output`
Streamed CLI events; backs the SSE stream.
`id` (INTEGER PK AUTOINCREMENT — the `?after=N` cursor), `run_id`, `event_type`
(`text_delta`/`tool_start`/`tool_end`/`thinking`/`info`/`error`/`result`),
`content`, `tool_name`, `created_at`. Index: `idx_run_output_run`.

### `run_attachments`
Files or embed URLs on a run.
`id`, `run_id`, `activity_id` (FK → run_activity, SET NULL), `kind` (CHECK
`file`/`embed`), `filename`, `storage_path` (relative to `uploadsDir()`),
`mime_type`, `size_bytes`, `url`, `embed_provider`, `title`,
`uploaded_by_type` (CHECK `user`/`agent`), `uploaded_by_id`, `uploaded_by_name`,
`created_at`. Indexes: `idx_run_attachments_run`, `idx_run_attachments_activity`.

## Resources — project-owned

Each carries a NOT NULL `project_id` FK (CASCADE).

### `docs`
`project_id`, `title`, `pinned` (default 0), `created_by_type`
(CHECK `user`/`agent`), `created_by_id`, timestamps. Titles are unrestricted —
no uniqueness constraint. Index: `idx_docs_project`.

### `doc_revisions`
Append-only history; newest row's `content` is the live body.
`doc_id` (FK → docs CASCADE), `content` (NN), `author_type`, `author_id`,
`created_at`. Index: `idx_doc_revisions_doc`.

### `env_vars`
Encrypted secrets (labeled "Secrets" in the UI).
`project_id`, `name`, `encrypted_value` (NN — AES-256-GCM as
`hex(iv):hex(tag):hex(ciphertext)`, 12-byte IV, 16-byte tag), `pinned`,
timestamps. **Name uniqueness per project is enforced in the query layer**, not
by a DB constraint (error copy: `already exists in this project`). Index:
`idx_env_vars_project`.

### `tables`
Registry of agent-managed SQLite tables (the data tables are siblings in the
same file). `project_id`, `name`, `table_name` (NN, **U** — the physical table
identifier, made globally unique by an id suffix), `pinned` (INTEGER NN,
default 0 — pinned tables are pre-selected for new jobs in the dashboard,
parity with `docs`/`env_vars`). Lookup by logical name is per project
(`getTableByName(projectId, name)`). Index: `idx_tables_project`.

### `table_migrations`
Per-table DDL history. `table_id`, `version` (NN), `description`, `sql`
(NN), `created_at`. Index: `idx_table_migrations_tbl`.

## Job-linked junctions

The **only** junction tables. Composite PKs, `ON DELETE CASCADE` both sides.
These attach a resource to a specific job — from **any** project (links are
unrestricted; inserts are `INSERT OR IGNORE`, so re-linking is a no-op).

| Table | A | B |
|---|---|---|
| `job_docs` | `job_id` → `jobs` | `doc_id` → `docs` |
| `job_env_vars` | `job_id` → `jobs` | `env_var_id` → `env_vars` |
| `job_tables` | `job_id` → `jobs` | `table_id` → `tables` |

Run-bundle composition: pinned resources of the job's **own** project come
first, then the linked resources (any project) in link-table rowid order —
on a name collision (env vars / tables are keyed by name in the payload) the
later assignment wins.

## Settings

### `settings`
`key` (PK), `value` (NN). **Instance-global KV** — holds the instance
`timezone` (read only through `getTimezone()` in `src/lib/db/settings.ts`,
falling back to the host timezone) and recent-feed limits. There is **no**
`signup_enabled` key (no web signup).

## Notable invariants

- **Claim atomicity.** `claimNextRun` / `peekClaim`
  (`src/lib/db/runs.ts`, behind `POST /api/runner/claim`) run the whole
  select-and-claim in one **IMMEDIATE** transaction, so concurrent claims
  serialize on the single SQLite writer. The guarded claim UPDATEs
  (`AND status = 'scheduled'/'pending'`) plus a lock-unit check — `agent_id`
  for agent runs, `job_id` for workflow runs, nothing in flight
  (`running`/`pending`; `waiting` is idle) — make a lost race a no-op, never a
  double-claim.
- **Workflows.** `jobs.kind = 'workflow'` ⇒ `agent_id` is NULL on both the job
  and its runs; claimed via `POST /api/runner/claim` like any other run (a
  runner advertising the `workflow` kind), no separate poll endpoint.
- **Env-var encryption.** Plaintext never lands in the DB; the key is read from
  `HARBOUR_ENCRYPTION_KEY` or auto-generated at `~/.harbour/encryption.key`.

## Schema initialization

A single `initializeSchema(db)` call from `getDb()` on first use runs the
`CREATE TABLE IF NOT EXISTS` block (the target shape) and an encryption-key
backfill, then `verifySchema` diffs the live DB against the expected shape and
refuses to boot on drift. There is no migrations folder; the schema file **is**
the schema — change the target shape directly and start from a fresh DB.
