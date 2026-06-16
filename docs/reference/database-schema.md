# Database schema

One SQLite file (default `~/.harbour/harbour.db`), `journal_mode = WAL`,
`foreign_keys = ON`, `busy_timeout = 5000`. **Source of truth:
`src/lib/db/schema.ts`** (`initializeSchema`). v2 is a clean break — there is no
v1 → v2 migration; a fresh database is the only supported path.

- **27 tables**, **35 explicit indexes** (plus auto-indexes on PK / UNIQUE).
- Timestamps are unix epoch seconds (`unixepoch()` defaults). Booleans are
  INTEGER 0/1. IDs are uuid TEXT **except** `run_output.id` and
  `captain_output.id`, which are AUTOINCREMENT integers used as SSE cursors.

Notation: **PK** / **FK**(cascade) / **NN** / **U** / **CHECK**. Defaults shown
only when non-trivial.

## Tenancy shape

The defining v2 structure — **instance admin → orgs → projects** — is enforced
in the schema, not bolted on:

- **Operational entities** (`agents`, `jobs`, `runs`) carry a direct
  `project_id` FK. There are **no** `project_*` junction tables (v1 had them).
- **Resources** (`docs`, `env_vars`, `tables`) are **dual-tier**: a NOT NULL
  `org_id` plus a NULLABLE `project_id`. `project_id IS NULL` ⇒ org-level (shared
  across the org); otherwise project-level.
- **Jobs are dual-tier too**, but only for workflows: `jobs` carries a NOT NULL
  `org_id` plus a NULLABLE `project_id`; `project_id IS NULL` ⇒ an org-level
  workflow job. Agent jobs are always
  project-level (a table CHECK enforces it). Scope is fixed at creation —
  `updateJob` cannot move a job between tiers — and an org-level job may link
  only org-level resources (linking a project-scoped doc/env var/table into
  an org-scoped job would widen its blast radius; the query layer rejects it
  and routes return 400).
- **Org-scoped** infrastructure: `captain_conversations`. The `runners`
  registry is **instance-level** (org-agnostic — execution doesn't see tenancy).
- `runs.org_id` and `runs.project_id` are denormalized (copied from the job) so
  org-scoped run queries need no join and org-level runs (`project_id` NULL)
  stay reachable.

## Slugs

`orgs`, `projects`, and `agents` each carry a `slug` (TEXT NN) — the
filesystem-safe workspace path segment runners use to nest workspaces as
`<org-slug>/<project-slug>/<agent-slug>`. Semantics (algorithm in
`src/lib/slug.ts`, enforcement in the create paths of the query layer):

- **Assigned at creation** from the name (lowercase; runs of non-`[a-z0-9]`
  collapse to a single `-`; trimmed). A name that slugifies to `""` is rejected.
- **Immutable on rename** — workspace paths stay stable.
- **Unique per scope**, enforced by unique indexes: org slugs instance-wide
  (`idx_orgs_slug`), project slugs per org (`idx_projects_org_slug`), agent
  slugs per project (`idx_agents_project_slug`). Archived rows keep their slug
  and still block reuse, so a new same-name org/project can't inherit leftover
  workspace directories on runner machines.

## Identity & access

### `users`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | uuid |
| `email` | TEXT | NN, U | |
| `password_hash` | TEXT | | argon2id; **NULLABLE** — admin-created until a set-password link is consumed |
| `display_name` | TEXT | NN | |
| `is_instance_admin` | INTEGER | NN, default 0 | owns the install; spans all orgs |
| `created_at` / `updated_at` | INTEGER | NN | |

### `orgs`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | NN | |
| `slug` | TEXT | NN, U | creation-time, immutable workspace path segment (see [Slugs](#slugs)) |
| `settings` | TEXT | NN, default `'{}'` | JSON, org-scoped (e.g. `timezone`) |
| `archived_at` | INTEGER | | soft-delete |
| `created_at` / `updated_at` | INTEGER | NN | |

Index: `idx_orgs_slug(slug)` (UNIQUE).

### `memberships`
Maps a user to an org with a role. Instance admins need **no** membership row.
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `user_id` | TEXT | PK, FK → `users` (CASCADE) | composite PK `(user_id, org_id)` |
| `org_id` | TEXT | PK, FK → `orgs` (CASCADE) | |
| `role` | TEXT | NN, CHECK in (`editor`, `viewer`) | |
| `created_at` | INTEGER | NN | |

Index: `idx_memberships_org(org_id)`.

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

Index: `idx_set_password_tokens_hash`.

### `admin_api_keys`
Bearer keys that resolve to the **creator's** user identity.
`id`, `name`, `api_key_hash` (NN, U — sha256), `created_by_user_id` (NN, FK →
users CASCADE), `last_used_at`, timestamps.

## Hierarchy

### `projects`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `org_id` | TEXT | NN, FK → `orgs` (CASCADE) | |
| `name` | TEXT | NN | |
| `slug` | TEXT | NN | unique per org; creation-time, immutable workspace path segment (see [Slugs](#slugs)) |
| `archived_at` | INTEGER | | soft-delete (normal path); hard delete is the admin escape hatch |
| `created_at` / `updated_at` | INTEGER | NN | |

Indexes: `idx_projects_org`, `idx_projects_org_slug(org_id, slug)` (UNIQUE).

## Operational entities

### `agents`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `project_id` | TEXT | NN, FK → `projects` (CASCADE) | |
| `name` | TEXT | NN | |
| `slug` | TEXT | NN | unique per project; creation-time, immutable workspace path segment (see [Slugs](#slugs)) |
| `description` | TEXT | | |
| `api_key_hash` | TEXT | NN | sha256 of the bearer key |
| `cli` | TEXT | | `claude` / `codex` / `gemini` (Harbour-run agents); NULL for external |
| `model` / `thinking` | TEXT | | default model + effort override |
| `color` | TEXT | | stored identity hue (user-selectable; name-hash fallback when null) |
| `eager` | INTEGER | NN, default 0 | drain queue without the 60s pause |
| `remote` | INTEGER | NN, default 0 | runner lives on another machine |
| `runner_fingerprint` | TEXT | | one-runtime-per-agent guard |
| `placement` | TEXT | NN, default `'local'` | routes this agent's runs to a runner tier/label (denormalized onto `runs.placement` at creation) |
| `last_polled_at` | INTEGER | | updated on each poll |
| `created_at` / `updated_at` | INTEGER | NN | |

There is no stored `type` column — an external agent simply has no runner
configured. Indexes: `idx_agents_project`,
`idx_agents_project_slug(project_id, slug)` (UNIQUE).

### `runners`
The **instance-level runner registry** — one row per runner (the auto-provisioned
local pool plus any remote runners). Org-agnostic on purpose: execution is
org-agnostic; tenancy only shapes what users see. Replaces the file-based agent
runner config (`runners.json`) and the per-org `workflow_runners` table.
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | NN | |
| `token_hash` | TEXT | NN, U | sha256 of the bearer token (`hbrn_…`) |
| `tier` | TEXT | NN, CHECK in (`local`, `remote`) | local = trusted/unscoped; remote = scoped |
| `labels` | TEXT | NN, default `'[]'` | JSON: placement labels this token is **authorized** to serve |
| `capabilities` | TEXT | | JSON `{kinds,clis,labels}` — last-**advertised** host capabilities (health/display) |
| `scope` | TEXT | | JSON `{orgId?,agentId?}` or NULL (unscoped — local tier) |
| `last_polled_at` | INTEGER | | updated on every claim/peek; drives the health surface |
| `created_at` / `updated_at` | INTEGER | NN | |

Index: `idx_runners_token(token_hash)` (UNIQUE).

### `jobs`
Static configuration for recurring work (agent or workflow).
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `org_id` | TEXT | NN, FK → `orgs` (CASCADE) | |
| `project_id` | TEXT | FK → `projects` (CASCADE) | **NULL = org-level (workflow jobs only)** |
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

Table CHECK: `kind != 'agent' OR project_id IS NOT NULL` — agent jobs can never
be org-level.

Indexes: `idx_jobs_org`, `idx_jobs_project`, `idx_jobs_agent`,
`idx_jobs_schedule(kind, agent_id, active, next_run_at)`.

### `runs`
A single execution of a job.
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `org_id` | TEXT | NN, FK → `orgs` (CASCADE) | denormalized from the job |
| `project_id` | TEXT | FK → `projects` (CASCADE) | denormalized from the job; **NULL = org-level job's run** |
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

Indexes: `idx_runs_org`, `idx_runs_project`, `idx_runs_job`, `idx_runs_agent`,
`idx_runs_status`, `idx_runs_claimed_by`.

### `run_activity`
Ordered message log. On workflow runs this is runner output only
(`workflow`/`system` authors), never a conversation.
`id`, `run_id`, `author_type` (NN, CHECK in `agent`/`user`/`system`/`workflow`),
`author_id`, `author_name`, `content`, `created_at`. Indexes:
`idx_run_activity_run`, `idx_run_activity_run_time(run_id, created_at)`.

### `run_output`
Streamed CLI events; backs the SSE stream.
`id` (INTEGER PK AUTOINCREMENT — the `?after=N` cursor), `run_id`, `event_type`
(`text_delta`/`tool_start`/`tool_end`/`thinking`/`info`/`error`/`result`),
`content`, `tool_name`, `created_at`. Index: `idx_run_output_run`.

### `run_attachments`
Files or embed URLs on a run.
`id`, `run_id`, `activity_id` (FK → run_activity, SET NULL), `kind` (CHECK
`file`/`embed`), `filename`, `storage_path` (relative to `uploadsDir()`),
`mime_type`, `size_bytes`, `url`, `embed_provider`, `title`, `uploaded_by_*`,
`created_at`. Indexes: `idx_run_attachments_run`, `idx_run_attachments_activity`.

### `attachment_processing`
ffmpeg + whisper state for a video attachment. `attachment_id` is **UNIQUE**
(one row per attachment; re-process deletes the old row first).
`status` CHECK in (`queued`, `processing`, `done`, `failed`); `transcript_path`,
`screenshots_dir`, `screenshot_count`, `screenshot_interval`,
`duration_seconds` (REAL), `error`, `started_at`, `completed_at`. Indexes:
`idx_attachment_processing_attachment`, `idx_attachment_processing_run`.

## Resources (dual-tier)

Each carries `org_id` (NN) and a NULLABLE `project_id` (`NULL` = org-level).

### `docs`
`org_id`, `project_id`, `title`, `pinned` (default 0), `created_by_type`
(CHECK `user`/`agent`), `created_by_id`, timestamps. Index:
`idx_docs_org_project(org_id, project_id)`.

### `doc_revisions`
Append-only history; newest row's `content` is the live body.
`doc_id` (FK → docs CASCADE), `content` (NN), `author_type`, `author_id`,
`created_at`. Index: `idx_doc_revisions_doc`.

### `env_vars`
Encrypted secrets (labeled "Secrets" in the UI).
`org_id`, `project_id`, `name`, `encrypted_value` (NN — AES-256-GCM as
`hex(iv):hex(tag):hex(ciphertext)`, 12-byte IV, 16-byte tag), `pinned`,
timestamps. **Name uniqueness is enforced in the query layer**, not by a DB
constraint, so a project-level name can override an org-level one. Index:
`idx_env_vars_org_project`.

### `tables`
Registry of agent-managed SQLite tables (the data tables are siblings in the
same file). `org_id`, `project_id`, `name`, `table_name` (NN, **U** — globally
unique physical identifier), `pinned` (INTEGER NN, default 0 — pinned tables
auto-attach to new jobs at creation, parity with `docs`/`env_vars`). Index:
`idx_tables_org_project`.

### `table_migrations`
Per-table DDL history. `table_id`, `version` (NN), `description`, `sql`
(NN), `created_at`. Index: `idx_table_migrations_tbl`.

## Job-linked junctions

The **only** junction tables in v2. Composite PKs, `ON DELETE CASCADE` both
sides. These attach a resource to a specific job (tier 3, on top of the org- and
project-level tiers).

| Table | A | B |
|---|---|---|
| `job_docs` | `job_id` → `jobs` | `doc_id` → `docs` |
| `job_env_vars` | `job_id` → `jobs` | `env_var_id` → `env_vars` |
| `job_tables` | `job_id` → `jobs` | `table_id` → `tables` |

## Settings

### `settings`
`key` (PK), `value` (NN). **True instance-global KV only** — e.g. Captain config
and video-processing settings. Org-scoped config (like `timezone`) lives in
`orgs.settings` JSON, not here. There is **no** `signup_enabled` key (no web
signup).

## Captain (per-org)

In-browser CLI chat; a server-side process manager spawns a CLI tool and streams
output over SSE.

- **`captain_conversations`** — `org_id`, `user_id`, `title`, `cli` (NN),
  `model`, `thinking`, `session_id`, `cwd` (overrides default `~/.harbour/captain/`).
- **`captain_messages`** — `conversation_id`, `role` (CHECK `user`/`assistant`),
  `content` (accumulates as the response streams).
- **`captain_output`** — `id` AUTOINCREMENT (SSE cursor), `conversation_id`,
  `message_id` (FK → captain_messages, nullable), `event_type`, `content`,
  `tool_name`.

Indexes: `idx_captain_conversations_org`, `idx_captain_conversations_user`,
`idx_captain_messages_conversation`, `idx_captain_output_conversation`.

## Notable invariants

- **Polling-ladder atomicity.** `claimNextRun` / `peekClaim`
  (`src/lib/db/runs.ts`, behind `POST /api/runner/claim`) run the whole
  select-and-claim in one **IMMEDIATE** transaction, so concurrent claims
  serialize on the single SQLite writer. The guarded claim UPDATEs
  (`AND status = 'scheduled'/'pending'`) plus a lock-unit check — `agent_id`
  for agent runs, `job_id` for workflow runs, nothing in flight
  (`running`/`waiting`/`pending`) — make a lost race a no-op, never a
  double-claim.
- **Dual-tier resolution.** For `docs`/`env_vars`/`tables`, `project_id IS
  NULL` means org-level; the query layer resolves project-over-org on name
  collisions.
- **Workflows.** `jobs.kind = 'workflow'` ⇒ `agent_id` is NULL on both the job
  and its runs; claimed via `POST /api/runner/claim` like any other run (a
  runner advertising the `workflow` kind), no separate poll endpoint.
  Workflow jobs may be org-level (`project_id` NULL — scope fixed at creation,
  org-level resources only); agent jobs never are (table CHECK).
- **Env-var encryption.** Plaintext never lands in the DB; the key is read from
  `HARBOUR_ENCRYPTION_KEY` or auto-generated at `~/.harbour/encryption.key`.
- **`run_activity.author_type`** allows `workflow`; `ensureRunActivityAuthorTypes`
  rebuilds the table once for DBs created before that value was permitted.

## Schema initialization

A single `initializeSchema(db)` call from `getDb()` on first use runs the
`CREATE TABLE IF NOT EXISTS` block (the target shape), the one-time
`run_activity` author-type rebuild, and an encryption-key backfill. There is no
migrations folder; the schema file **is** the schema — change the target shape
directly and start from a fresh DB.
