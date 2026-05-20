# Harbour — Technical Specification

A control plane for AI agents doing ongoing work. Next.js (App Router), SQLite (better-sqlite3), Tailwind / shadcn/ui, TypeScript. Single-process deployment — no external database, no Redis, no background workers.

All state lives under `~/.harbour` by default (DB, uploads, encryption key, runner config).

---

## Table of Contents

- [Database Schema](#database-schema)
- [Authentication & Authorization](#authentication--authorization)
- [API Routes](#api-routes)
- [Run Lifecycle & Scheduling](#run-lifecycle--scheduling)
- [CLI & Agent Runner](#cli--agent-runner)
- [Shared Context (Docs, Databases, Env Vars)](#shared-context)
- [Attachments & Video Processing](#attachments--video-processing)
- [Projects](#projects)
- [Frontend Architecture](#frontend-architecture)

---

## Database Schema

Single SQLite file (default `~/.harbour/harbour.db`). PRAGMAs: `journal_mode = WAL`, `foreign_keys = ON`. All timestamps are unix epoch integers (seconds). Booleans are INTEGER 0/1. IDs are UUIDs (TEXT) except `run_output.id` which is auto-incrementing INTEGER.

### Core Tables

**users** — Dashboard accounts. Columns: `id`, `email` (unique), `password_hash`, `display_name`, `created_at`, `updated_at`.

**sessions** — Login sessions. Columns: `id`, `user_id` (FK → users, cascade), `expires_at`, `created_at`. Indexed on `user_id`.

**agents** — External or harbour CLI agents that execute jobs. Columns: `id`, `name`, `description`, `api_key_hash`, `last_polled_at`, `type` (default `'external'`), `cli`, `model`, `thinking`, `remote` (default 0; runner lives off-host), `eager` (default 0; drain queue without 60s pauses), `created_at`, `updated_at`. Deleting an agent cascades to its jobs, runs, and project links.

**jobs** — Recurring or one-off responsibilities assigned to an agent. Columns: `id`, `agent_id` (FK → agents, cascade), `name`, `description`, `instructions`, `schedule` (JSON), `check_command`, `timeout_minutes` (default 30), `one_off` (default 0), `active` (default 1), `model`, `thinking`, `last_run_at`, `next_run_at`, `created_at`, `updated_at`. Indexed on `agent_id` and composite `(agent_id, active, next_run_at)` for scheduler queries.

**runs** — Single execution of a job. Columns: `id`, `job_id` (FK → jobs, cascade), `agent_id` (FK → agents, cascade), `status` (CHECK: `scheduled`, `running`, `waiting`, `pending`, `done`, `failed`, `skipped`, `killed`), `scheduled_for`, `claimed_at`, `completed_at`, `kill_requested_at`, `extra_instructions`, `created_at`, `updated_at`. Indexed on `job_id`, `agent_id`, `status`.

**run_activity** — Ordered message log within a run. Columns: `id`, `run_id` (FK → runs, cascade), `author_type` (CHECK: `agent`, `user`, `system`), `author_id`, `author_name`, `content`, `created_at`. Indexed on `run_id` and composite `(run_id, created_at)`.

**run_output** — Streaming CLI output events. Columns: `id` (INTEGER AUTOINCREMENT), `run_id` (FK → runs, cascade), `event_type`, `content`, `tool_name`, `created_at`. Event types: `text_delta`, `thinking`, `tool_start`, `tool_end`, `info`, `result`, `error`. Indexed on `run_id`.

### Shared Context Tables

**docs** — Markdown documents linked to jobs. Columns: `id`, `title`, `pinned` (default 0), `created_by_type` (CHECK: `user`, `agent`), `created_by_id`, `created_at`, `updated_at`.

**doc_revisions** — Version history for docs. Columns: `id`, `doc_id` (FK → docs, cascade), `content`, `author_type`, `author_id`, `created_at`. Indexed on `doc_id`.

**databases** — Agent-managed SQLite tables. Columns: `id`, `name` (unique), `table_name` (unique), `created_at`, `updated_at`. The actual data table is created dynamically in the same SQLite DB.

**database_migrations** — Schema versions for agent databases. Columns: `id`, `database_id` (FK → databases, cascade), `version`, `description`, `sql`, `created_at`. Indexed on `database_id`.

**env_vars** — Encrypted key-value pairs. Columns: `id`, `name` (unique), `encrypted_value`, `pinned` (default 0), `created_at`, `updated_at`. Values encrypted with AES-256-GCM.

**settings** — System key-value config. Columns: `key` (PK), `value`. Defaults: `timezone` (system TZ), `signup_enabled` (`'true'`).

### Attachment Tables

**run_attachments** — Files and embeds attached to runs. Columns: `id`, `run_id` (FK → runs, cascade), `activity_id` (FK → run_activity, SET NULL on delete), `kind` (CHECK: `file`, `embed`), `filename`, `storage_path`, `mime_type`, `size_bytes`, `url`, `embed_provider`, `title`, `uploaded_by_type`, `uploaded_by_id`, `uploaded_by_name`, `created_at`. Indexed on `run_id` and `activity_id`.

**attachment_processing** — Video processing queue. Columns: `id`, `attachment_id` (unique, FK → run_attachments, cascade), `run_id`, `status` (CHECK: `queued`, `processing`, `done`, `failed`), `transcript_path`, `screenshots_dir`, `screenshot_count`, `screenshot_interval`, `duration_seconds`, `error`, `started_at`, `completed_at`, `created_at`. Indexed on `attachment_id` and `run_id`.

### Junction Tables

All use composite primary keys and CASCADE deletes on both sides.

| Table | Links |
|---|---|
| `job_docs` | jobs ↔ docs |
| `job_databases` | jobs ↔ databases |
| `job_env_vars` | jobs ↔ env_vars |
| `project_agents` | projects ↔ agents |
| `project_jobs` | projects ↔ jobs |
| `project_docs` | projects ↔ docs |
| `project_env_vars` | projects ↔ env_vars |
| `project_databases` | projects ↔ databases |

### Admin

**admin_api_keys** — Full-access management keys. Columns: `id`, `name`, `api_key_hash` (unique), `created_by_user_id` (FK → users, cascade), `last_used_at`, `created_at`, `updated_at`. Resolves to creating user's identity for audit trails.

**25 tables total.** Migrations use table recreation for CHECK constraint changes (SQLite limitation). All foreign keys cascade on delete.

---

## Authentication & Authorization

Three auth principals, resolved in `src/lib/auth.ts`:

1. **User sessions** — Cookie-based (`harbour_session`, httpOnly, 30-day expiry). Created on login, stored in `sessions` table.
2. **Agent API keys** — Bearer token in `Authorization` header. Hashed with SHA-256 and stored in `agents.api_key_hash`. Scoped to a single agent.
3. **Admin API keys** — Bearer token (prefix `hbr_adm_`). Hashed and stored in `admin_api_keys`. Resolves to the creating user's identity — admin keys act as the user who created them.

### Auth Wrappers

All API routes use one of two HOF wrappers (never inline auth):

- **`withAuth(handler)`** — Accepts any principal (user, agent, or admin key). Used for routes shared between dashboard and agents.
- **`withUserAuth(handler)`** — User-only (session or admin key). Returns 403 for agent keys. Used for management operations.

### Ownership Enforcement

Agent-facing mutation routes call `requireAgentOwnership(auth, agentId)` after auth. If the caller is an agent, it must own the resource. Users pass through unconditionally.

### Signup & Login

- `POST /api/auth/signup` — Creates account (gated by `signup_enabled` setting). Password min 6 chars, hashed with bcrypt.
- `POST /api/auth/login` — Validates credentials, creates session, sets cookie.
- `POST /api/auth/logout` — Destroys session, clears cookie.
- `GET /api/auth/me` — Returns current principal (user or agent).

### API Key Generation

Agent keys are generated as random UUIDs on agent creation. Shown once in the response, then only the SHA-256 hash is stored. Admin keys use a `hbr_adm_` prefix. Both support key rotation.

---

## API Routes

69 route handlers across 11 domains. Auth distribution: ~40 `withAuth`, ~20 `withUserAuth`, 3 unauthenticated (signup, login, guide).

### Agents

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/agents` | withAuth | List agents (optional `projectId` filter) |
| POST | `/api/agents` | withUserAuth | Create agent, returns one-time `apiKey` |
| GET | `/api/agents/[id]` | withAuth | Get agent details |
| PUT | `/api/agents/[id]` | withAuth | Update agent metadata |
| DELETE | `/api/agents/[id]` | withUserAuth | Delete agent + cleanup runner config |
| POST | `/api/agents/[id]/rotate-key` | withUserAuth | Rotate API key |
| GET | `/api/agents/[id]/next` | withAuth + ownership | Poll for work (`?peek=true` for read-only check) |
| GET | `/api/agents/[id]/jobs` | withAuth | List agent's jobs |
| POST | `/api/agents/[id]/jobs` | withAuth | Create job for agent |
| POST | `/api/agents/[id]/data` | withAuth | Create database + optionally link to job + insert rows |

### Runs

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/runs` | withAuth | List runs grouped by status (or filter: `waiting`, `recent`) |
| POST | `/api/runs` | withAuth | Create one-off run |
| GET | `/api/runs/[id]` | withAuth | Get run with activity + attachments |
| DELETE | `/api/runs/[id]` | withUserAuth | Delete run |
| PUT | `/api/runs/[id]/status` | withAuth + ownership | Update status (adds system activity) |
| GET | `/api/runs/[id]/activity` | withAuth | List activity log |
| POST | `/api/runs/[id]/activity` | withAuth + ownership | Post message; user reply auto-transitions waiting→pending |
| GET | `/api/runs/[id]/output` | withAuth | Fetch historical output events |
| POST | `/api/runs/[id]/output` | withAuth + ownership | Write output events; piggybacks kill signal in response |
| GET | `/api/runs/[id]/output/stream` | withAuth | SSE stream of output (polls DB every 500ms) |
| GET | `/api/runs/[id]/kill` | withAuth + ownership | Check kill flag (lightweight poll) |
| POST | `/api/runs/[id]/kill` | withUserAuth | Request kill (harbour agents only, running status only) |
| POST | `/api/runs/[id]/retry` | withUserAuth | Retry failed/skipped/killed → pending |

### Run Attachments

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/runs/[id]/attachments` | withAuth + ownership | List attachments |
| POST | `/api/runs/[id]/attachments` | withAuth + ownership | Upload file (multipart) or embed URL (JSON) |
| DELETE | `/api/runs/[id]/attachments/[aid]` | withAuth + ownership | Delete attachment |
| GET | `/api/runs/[id]/attachments/[aid]/file` | withAuth + ownership | Download file |
| GET | `/api/runs/[id]/attachments/[aid]/processing` | withAuth + ownership | Video processing status |
| POST | `/api/runs/[id]/attachments/[aid]/processing` | withAuth + ownership | Trigger video processing |
| GET | `/api/runs/[id]/attachments/[aid]/transcript` | withAuth + ownership | Get transcript (`?format=plain` or storyboard) |
| GET | `/api/runs/[id]/attachments/[aid]/screenshots` | withAuth + ownership | List screenshots (paginated) |
| GET | `/api/runs/[id]/attachments/[aid]/screenshots/[index]/file` | withAuth + ownership | Download screenshot JPEG |

### Jobs

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/jobs` | withAuth | List jobs (optional `projectId`) |
| GET | `/api/jobs/[id]` | withAuth | Get job details |
| PUT | `/api/jobs/[id]` | withAuth | Update job |
| DELETE | `/api/jobs/[id]` | withAuth | Delete job |
| POST | `/api/jobs/[id]/trigger` | withAuth | Trigger job immediately (optional extra instructions) |
| POST | `/api/jobs/[id]/docs` | withAuth | Link doc |
| DELETE | `/api/jobs/[id]/docs/[docId]` | withAuth | Unlink doc |
| POST | `/api/jobs/[id]/data` | withAuth | Link database |
| DELETE | `/api/jobs/[id]/data/[dataId]` | withAuth | Unlink database |
| POST | `/api/jobs/[id]/env-vars` | withAuth | Link env var |
| DELETE | `/api/jobs/[id]/env-vars/[envVarId]` | withAuth | Unlink env var |

### Docs

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/docs` | withAuth | List docs (optional `projectId`) |
| POST | `/api/docs` | withAuth | Create doc |
| GET | `/api/docs/[id]` | withAuth | Get doc with latest content |
| PUT | `/api/docs/[id]` | withAuth | Update doc (creates revision) |
| DELETE | `/api/docs/[id]` | withAuth | Delete doc |
| POST | `/api/docs/[id]/pin` | withAuth | Toggle pinned status |
| GET | `/api/docs/[id]/revisions` | withAuth | List revision history |

### Databases

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/databases` | withAuth | List databases (optional `projectId`) |
| POST | `/api/databases` | withAuth | Create database (returns existing if name matches) |
| GET | `/api/databases/[id]` | withAuth | Get database with migrations and linked jobs |
| DELETE | `/api/databases/[id]` | withAuth | Delete database |
| POST | `/api/databases/[id]/columns` | withAuth | Add column (tracked as migration) |
| GET | `/api/databases/[id]/rows` | withAuth | Read rows (paginated, sortable) |
| POST | `/api/databases/[id]/rows` | withAuth | Insert rows (single or batch) |
| PUT | `/api/databases/[id]/rows/[rowId]` | withAuth | Update row |
| DELETE | `/api/databases/[id]/rows/[rowId]` | withAuth | Delete row |

### Env Vars

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/env-vars` | withAuth | List env vars (values masked) |
| POST | `/api/env-vars` | withUserAuth | Create encrypted env var |
| GET | `/api/env-vars/[id]` | withAuth | Get env var (masked) |
| PUT | `/api/env-vars/[id]` | withAuth | Update env var |
| DELETE | `/api/env-vars/[id]` | withAuth | Delete env var |
| GET | `/api/env-vars/[id]/value` | withUserAuth | Get decrypted value |
| POST | `/api/env-vars/[id]/pin` | withAuth | Toggle pinned status |

### Projects

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/projects` | withUserAuth | List projects |
| POST | `/api/projects` | withUserAuth | Create project |
| GET | `/api/projects/[id]` | withUserAuth | Get project |
| PUT | `/api/projects/[id]` | withUserAuth | Rename project |
| DELETE | `/api/projects/[id]` | withUserAuth | Delete project (entities unaffected) |
| PATCH | `/api/projects/[id]` | withUserAuth | Link/unlink entities |

### Settings & System

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/settings` | withAuth | Get all settings |
| PUT | `/api/settings` | withUserAuth | Update settings |
| GET | `/api/settings/timezones` | withAuth | List supported timezones |
| GET | `/api/settings/video-processing/check` | withUserAuth | Check ffmpeg/whisper availability |
| GET | `/api/system/cli-tools` | withAuth | Check CLI tool availability |
| GET | `/api/system/upload-config` | withAuth | Get upload size limits |
| GET | `/api/users` | withAuth | List users |

### Admin API Keys

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/admin-api-keys` | withUserAuth | List keys |
| POST | `/api/admin-api-keys` | withUserAuth | Create key (returns one-time `apiKey`) |
| DELETE | `/api/admin-api-keys/[id]` | withUserAuth | Revoke key |

### Documentation

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/guide` | none | Agent API guide (GUIDE.md) |
| GET | `/api/admin-guide` | withUserAuth | Admin API guide (ADMIN_GUIDE.md) |

---

## Run Lifecycle & Scheduling

### Status State Machine

```
scheduled → running → done
                    → failed
                    → skipped (pre-run check)
                    → waiting → pending → running → ...
                    → killed  → pending → running → ...
```

Terminal states: `done`, `failed`, `skipped`, `killed`. All set `completed_at`. Failed/skipped/killed can be retried (→ `pending`). User comments on waiting/done/failed/killed auto-transition to `pending`.

### Run Creation

**Recurring jobs**: `getAgentNextRun(agentId)` wraps all assignment in a transaction. Priority order: (1) pending runs (human responded), (2) scheduled one-off runs past their time, (3) recurring jobs past `next_run_at`. Creates run with `status = 'running'` and immediately advances the job's schedule so it won't re-fire on next poll.

**One-off runs**: `createOneOffRun()` creates a hidden job (`one_off = 1`, `schedule = '{}'`) and a run with `status = 'scheduled'`, `scheduled_for = runAt || now`. Picked up on next agent poll.

**Triggered runs**: `POST /api/jobs/[id]/trigger` creates a run with `status = 'scheduled'`, `scheduled_for = now`, and optional `extra_instructions` appended to job instructions.

### Polling via /next

`GET /api/agents/:id/next` is the only way agents get work. On each call:

1. `failStaleRuns()` — marks running runs that exceeded `timeout_minutes` (default 30) as `failed`
2. Check if agent already has a running run → return null (busy)
3. Look for pending run → transition to running
4. Look for scheduled run ready to start → transition to running
5. Look for recurring job past schedule → create run + advance schedule
6. `buildRunPayload()` assembles: run + activity, job instructions (with extra_instructions merged), linked docs (latest revision content), linked database rows (100 most recent per table), decrypted env vars, serialized attachments, and an `api` section with pre-resolved endpoints

`?peek=true` does the same checks without claiming anything — used by the dashboard to show agent availability.

### Status Transitions

`updateRunStatus(id, status)` handles all side effects:

- **Entering terminal state** (done/failed/skipped/killed): sets `completed_at`, clears `kill_requested_at`
- **done/failed/skipped**: advances job schedule. For one-off jobs: deactivates (`active = 0, next_run_at = NULL`). For recurring: calculates next `next_run_at`.
- **killed**: does NOT advance schedule — user stopped it intentionally and may resume via comment

### Kill Signal (Two-Tier)

Only harbour agents can be killed (external agents manage their own lifecycle).

1. **User requests kill**: `POST /api/runs/:id/kill` sets `kill_requested_at = unixepoch()` on the run
2. **Fast path (piggyback)**: Runner posts output events via `POST /api/runs/:id/output` every ~750ms. Kill signal included in response: `{ ok: true, kill_requested: true }`. Latency: ≤750ms.
3. **Fallback path (poll)**: Runner polls `GET /api/runs/:id/kill` every 10s for when output posting stalls. Latency: ≤10s.
4. Runner sends SIGTERM to CLI process, waits 3s grace, then SIGKILL if still alive
5. Session is saved so the run can be resumed via a user comment

### Timeout

`failStaleRuns(agentId)` runs at the start of every poll. Checks `updated_at + (timeout_minutes * 60) < now` for all running runs. Failed runs get a system activity message and one-off jobs are deactivated.

### Retry

`POST /api/runs/:id/retry` (user-only). Transitions failed/skipped/killed → `pending`. Agent picks it up on next poll. If the runner saved a session (killed runs), the agent resumes where it left off.

### Human Interaction

Agent sets status to `waiting` when it needs input. User posts a comment via `POST /api/runs/:id/activity`. If the run is in waiting/done/failed/killed, the system auto-transitions to `pending` and adds a system activity message.

### Schedule Parsing

`normalizeSchedule(input)` converts various formats to canonical JSON:

- **Interval**: `"every 5 minutes"` → `{"every": 5}`
- **Weekly**: `"weekdays at 9am"` → `{"days": [1,2,3,4,5], "time": "09:00"}`
- **Cron**: `"*/5 * * * *"` → `{"every": 5}`, `"0 9 * * 1-5"` → weekdays at 09:00
- **Shortcuts**: `"daily"`, `"hourly"`, `"daily at 2:30pm"`, `"weekly on monday at 9am"`

`getNextRunTime(schedule, from?, timezone?)` calculates the next Unix epoch. Intervals snap to boundaries. Weekly schedules use `Intl.DateTimeFormat` for timezone-aware wall-clock calculations with DST handling.

---

## CLI & Agent Runner

### Architecture

The runner (`bin/harbour.mjs`) is a Node.js CLI with commands: `agent list`, `agent run`, `agent install`, `agent uninstall`. It polls the Harbour server via HTTP, spawns CLI tools, streams output, and handles kill signals.

### Runner Config

Stored at `~/.harbour/runners.json`:

```json
{
  "runners": [
    {
      "agentId": "uuid",
      "name": "Agent Name",
      "apiKey": "hbr_...",
      "cli": "claude|codex|gemini",
      "model": "sonnet|null",
      "thinking": "high|null",
      "url": "https://harbour.example.com"
    }
  ]
}
```

Model and thinking can be set per agent (default) and overridden per job. The runner applies: `job.model || agent.model`, `job.thinking || agent.thinking`.

### Execution Flow

1. **Poll**: `GET /api/agents/:id/next` for each configured runner (all in parallel via `Promise.allSettled`)
2. **Check command**: If job has `check_command`, run it as bash with payload JSON on stdin. Exit 0 = proceed, exit 1 = skip silently, exit 2+ = error. Stdout appended to prompt.
3. **Build prompt**: Assembles job instructions, docs, database data, activity log, attachments, env vars, API reference, and check output
4. **Spawn CLI**: Provider builds command with model/thinking flags and session ID
5. **Stream output**: Lines parsed as JSONL, normalized to common event types, batched every 750ms, posted to `/api/runs/:id/output`
6. **Kill handling**: Detected via piggyback (750ms) or fallback poll (10s). SIGTERM → 3s grace → SIGKILL
7. **Post-execution**: Parse result, post as activity. If agent didn't set terminal status, mark as `failed` (failsafe). Save session if `waiting`, delete otherwise.

### Providers

Each provider (`bin/lib/providers.mjs`) implements: `buildCommand()`, `parseLine()`, `parseResult()`, and optionally `generateSessionId()`.

**Claude Code** (`claude`): `--output-format stream-json --verbose`, plus `--dangerously-skip-permissions` unless the workspace has a valid `.claude/settings.json` with a `permissions` object — in which case the flag is omitted and the permission system runs. Detection rejects non-regular files, zero-byte placeholders, and unparseable JSON to avoid silent fallback into a half-configured permission mode (`bin/lib/providers.mjs`). Session management via `--session-id` (new) or `--resume` (resume). Effort levels: low/medium/high/max.

**Codex** (`codex`): `exec --dangerously-bypass-approvals-and-sandbox --json`. Thread-based sessions via `--resume`. Reasoning effort: low/medium/high.

**Gemini CLI** (`gemini`): `--prompt "..." --yolo -o stream-json`. Session-based via `--resume`. Thinking levels: low/medium/high.

### Sessions

Stored at `~/.harbour/sessions.json`. Maps run IDs to `{ sessionId, cli }`. Saved when run reaches `waiting` (agent expects to resume). Deleted on terminal status or failed execution. Enables resume by passing session ID to CLI tool.

### Working Directories

Each agent gets `~/.harbour/workspaces/<agent-name-slugified>/`. CLI tools run in this directory, so file operations are sandboxed per agent.

### launchd Integration

`harbour agent install` creates `~/Library/LaunchAgents/com.harbour.agent-runner.plist`. Runs `harbour agent run` every 60 seconds. Logs to `~/.harbour/runner.log` and `~/.harbour/runner.err.log`. Passes PATH and HOME for CLI tool discovery. The Docker (`Dockerfile.runner`) and systemd (`harbour-agent-runner.service`) variants use `while true; do … sleep 60; done` for the same effective cadence.

### Eager polling

Agents with `agents.eager = 1` make the runner loop within a single tick rather than waiting for launchd's next 60s firing. After a run completes, the runner re-polls `/next` immediately if the outcome was `done`/`waiting`/`skipped`; it bails on `failed`/`killed`/empty-poll/poll-error. Hard cap of 50 iterations per tick (`EAGER_MAX_ITERATIONS`). The flag is read live from the `agent.eager` field on the `/next` response payload, so dashboard toggles take effect without reconnecting remote runners. Decision logic: `shouldContinueEagerLoop` (`bin/lib/runner.mjs`).

### Normalized Event Types

All providers map to: `text_delta`, `thinking`, `tool_start`, `tool_end`, `info`, `result`, `error`. Displayed in the dashboard's live output terminal.

### Environment Stripping and Layering

The runner strips Claude Code nesting guard env vars (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION`, `CLAUDE_CODE_PARENT_SESSION`) before spawning, preventing the spawned process from detecting it's inside another Claude Code session. After stripping, `runCliTool` layers `payload.env` (decrypted job env vars) onto the spawned process environment via the `extraEnv` parameter — this puts secrets in the actual process env where the agent's shell can expand `$VAR` natively, rather than forcing the LLM to emit the secret as text in a Bash command (which a Claude permission `dontAsk` mode auto-denies).

If the workspace contains a `bin/` directory, it is prepended to PATH so per-agent wrapper scripts resolve as bare command names — useful in combination with permission-system gating, since wrappers can read env vars internally and the LLM-visible command stays clean.

---

## Shared Context

### Docs

Versioned markdown documents linked to jobs via `job_docs`. Every content update creates a new `doc_revisions` row tracking author and timestamp. Revision history accessible via API. Latest revision content is injected into the `/next` payload.

**Pinning**: Pinned docs (`pinned = 1`) auto-attach to all new jobs and one-off runs. Pinning is checked at job creation time only — pinning/unpinning a doc does not retroactively affect existing jobs.

### Databases

Agent-managed dynamic SQLite tables in the same DB file. Each database gets a table named `d_<sanitized_name>` with an auto-increment `_id` column. Schema evolution tracked in `database_migrations` with version numbers.

**Column types**: TEXT, INTEGER, REAL. Column names validated against reserved words. New required columns must have defaults (SQLite ALTER TABLE limitation).

**Row operations**: Paginated reads with sort, bulk insert, single-row update/delete. Unknown columns silently ignored on insert. Recent rows (100, newest first) included in `/next` payload for linked databases.

Databases do not support pinning — they must be explicitly linked to jobs.

### Env Vars

Encrypted key-value pairs for secrets (API keys, tokens). Values encrypted at rest with AES-256-GCM.

**Encryption**: 32-byte key loaded from `HARBOUR_ENCRYPTION_KEY` env var or `~/.harbour/encryption.key` (auto-generated on first run, mode 0600). Each value encrypted with random 12-byte IV. Stored as `iv_hex:auth_tag_hex:encrypted_hex`.

**Decryption**: Only happens in-memory when building the `/next` payload (`getDecryptedEnvVarsForJob`). Never returned in list endpoints. Dashboard can reveal individual values via `GET /api/env-vars/:id/value` (user-only auth).

**Pinning**: Same as docs — pinned env vars auto-attach to all new jobs. Checked at creation time only.

### Auto-Attachment Flow

When `createJob()` or `createOneOffRun()` runs:
1. Merge explicitly selected doc/env-var IDs with all pinned IDs into a Set (deduplication)
2. `INSERT OR IGNORE` into junction tables for each ID
3. Result: every new job gets pinned items plus any explicitly chosen ones

---

## Attachments & Video Processing

### File Uploads

Multipart upload via `POST /api/runs/:id/attachments`. Files stored at `~/.harbour/uploads/runs/<runId>/`. Filenames sanitized (max 80 char stem + 16 char extension). Size limit: `HARBOUR_MAX_UPLOAD_MB` (default 500MB), enforced during streaming parse via Busboy.

Files written to temp path first (`.{uuid}__{filename}.tmp`), atomically renamed on success, cleaned up on error.

### Embed Attachments

JSON POST with `{ url, title? }`. URL matched against known providers: YouTube (youtube.com, youtu.be), Loom (loom.com), Vimeo (vimeo.com). Stored as `kind = 'embed'` with `embed_provider` set.

### Serialization

`serializeAttachment()` converts `storage_path` to a full download URL (`/api/runs/:id/attachments/:aid/file`). Embeds expose the original URL. Download serves files inline for images/video/PDF, as attachment otherwise.

### Video Processing Pipeline

Optional automatic processing triggered on video upload (if `video_auto_process` setting enabled) or manually via `POST /api/runs/:id/attachments/:aid/processing`.

**Steps**:
1. Extract duration via `ffprobe`
2. Extract screenshots via `ffmpeg` at configurable interval (default 5s). Stored as `0001.jpg`, `0002.jpg`, etc. in `processed/<attachmentId>/screenshots/`. Capped at 500 screenshots.
3. Extract audio to MP3, then transcribe via local Whisper CLI, OpenAI Whisper API, or Gemini Vision API
4. Generate storyboard: interleaved screenshots + transcript segments as markdown
5. Store paths and counts in `attachment_processing` table

**Status**: `queued` → `processing` → `done` | `failed`. UI polls every 3s while processing.

**API**: Screenshots served individually as JPEGs (1-day cache). Transcript available as plain text or storyboard format. Processing status includes screenshot count, duration, and error info.

---

## Projects

Projects are an optional view-layer grouping. They don't own entities — they hold references via junction tables. Entities can belong to multiple projects or none.

### Linking

Five junction tables: `project_agents`, `project_jobs`, `project_docs`, `project_env_vars`, `project_databases`. All use composite PKs and CASCADE deletes.

`PATCH /api/projects/:id` with `{ action: "link"|"unlink", type, targetId }` manages links.

**Auto-linking on job link**: When a job is linked to a project, `linkJobToProject()` also links the job's agent, docs, env vars, and databases in a transaction. All use `INSERT OR IGNORE`.

### Filtering

Client-side: `useProjectFilter()` hook returns `?projectId=xxx` or empty string. `useActiveProjectId()` returns raw ID. Active project stored in `localStorage["harbour_active_project"]`.

Server-side: All list queries accept optional `projectId` param. When present, filter via `WHERE id IN (SELECT ... FROM project_xxx WHERE project_id = ?)`.

Switching projects in the UI invalidates all React Query keys, triggering refetch with the new filter.

### Deletion

Deleting a project removes only the junction table rows (CASCADE). All entities remain at the top level.

---

## Frontend Architecture

### Stack

Next.js App Router, React 19, Tailwind CSS v4 (oklch color space, CSS variable theming), shadcn/ui (base-ui primitives), React Query (TanStack Query), Geist font family.

### Layout Hierarchy

**Root layout** (`src/app/layout.tsx`): HTML metadata, PWA manifest, Geist fonts, early theme detection script (prevents flash).

**Auth layout** (`src/app/(auth)/`): Login and signup pages, standalone without app shell.

**App layout** (`src/app/(app)/layout.tsx`): Wraps all authenticated pages with `QueryProvider` and `AppShell`.

**AppShell** (`src/components/app/app-shell.tsx`): Auth enforcement (fetches `/api/auth/me`, redirects to `/login` on failure). Desktop sidebar (56px) + mobile header/bottom nav. Provides `AppContext` via `useApp()` hook with: user, waitingCount, timezone, projects, activeProjectId.

### Pages

| Path | Purpose |
|------|---------|
| `/` | Runs dashboard — scheduled, running, waiting, pending, recent |
| `/runs/[id]` | Run detail — activity, live output (SSE), reply form, attachments |
| `/jobs` | Job list with schedules, run counts |
| `/jobs/[id]` | Job detail with linked docs/databases/env-vars, run history |
| `/agents` | Agent list with poll status |
| `/agents/[id]` | Agent detail with jobs, activity |
| `/docs` | Doc list |
| `/docs/[id]` | Doc editor with revision history |
| `/databases` | Database list with row counts |
| `/databases/[id]` | Database viewer with rows |
| `/env-vars` | Env var list (values masked) |
| `/settings` | Timezone, signup control, project management, admin API keys |
| `/users` | User list |

### Key Shared Components

- **CreateDialog**: Tabbed modal for creating runs (one-off) and jobs. Agent selection, doc/env-var pickers, schedule picker, file uploads, model/thinking overrides.
- **TriggerDialog**: Confirm modal for manually triggering a job with optional extra instructions.
- **ProjectSwitcher**: Dropdown in sidebar/mobile header. On switch, invalidates all query keys.
- **ProjectLinkDialog**: "Add Existing" dialog for linking unlinked entities to a project.
- **SchedulePicker**: Weekly (days + time) or interval (minutes) picker. Serializes to JSON for API.
- **StatusBadge/StatusDot/RunStatusIcon**: Color-coded run status indicators.
- **AttachmentComposer/AttachmentDisplay**: File/embed upload UI with progress tracking and preview.
- **ModelThinkingSelect**: Model and thinking level selector, conditional on harbour agent type.

### State Management

**React Query**: `staleTime: 2000ms`, `refetchOnWindowFocus: true`. Most lists refetch every 5s. Mutations use inline fetch + manual `invalidateQueries`. No global state library — context via `AppContext`.

**Polling intervals**: Projects every 10s. Runs, agents, waiting count every 5s. Run detail page every 5s.

**SSE**: Run detail page connects to `/api/runs/:id/output/stream` for live output. Events deduplicated by ID. Auto-scrolls terminal. Closes on terminal status.

### Mobile

Uses Tailwind `md:` breakpoint (768px). Desktop: fixed left sidebar. Mobile: fixed top header + bottom tab bar with "More" sheet. Safe area insets for notch devices (`env(safe-area-inset-top/bottom)`).

### PWA

`display: standalone`, SVG + PNG icons (192/512), maskable icon. Apple web app capable with black-translucent status bar. No service worker (no offline support).

### Theming

CSS variables in oklch color space. Light/dark modes with separate palettes. Three-way toggle: Light, Dark, System (respects OS preference). Persisted to `localStorage["harbour_theme"]`. Default hue: 285 (violet).
