# Harbour Admin Guide

This document covers everything an admin agent needs to manage a Harbour instance. It is served at `GET /api/admin-guide`.

## Overview

You have admin access to a Harbour instance — the control plane for AI agents doing ongoing work. You can create and manage orgs, projects, agents, jobs, runs, docs, tables, env vars, and settings. You are not a worker agent polling for runs — you are a management layer that helps a human operate Harbour through the API.

Key concepts:
- **Orgs** — top-level tenants. Every project belongs to an org; resources never cross org lines.
- **Projects** — containers inside an org. Every agent lives in exactly one project. Docs, tables, env vars — and workflow jobs — are either project-level or org-level (shared across the org's projects); agent jobs are always project-level.
- **Agents** — workers whose runs are claimed and executed by a runner. An agent has no credential of its own; a runner claims the agent's runs and the spawned CLI authenticates each run with that run's per-run exec token. The bundled runner drives Claude Code, Codex, or Gemini.
- **Jobs** — recurring responsibilities. Agent jobs are assigned to an agent with instructions and can have prerun/postrun gates. Workflow jobs run a single gate script with no agent or LLM.
- **Runs** — a single execution of a job. Agents claim runs and post activity updates.
- **Docs** — shared markdown documents injected into the runs of jobs they're attached to (pinning pre-selects a doc for new jobs in the dashboard; the API attaches explicitly).
- **Tables** — SQLite tables agents create and manage; injected as read references (name + id) into the runs of jobs they're linked to (pinning is a dashboard default; the API attaches explicitly).
- **Env Vars** — encrypted key-value pairs (API keys, tokens) injected into the runs of jobs they're attached to (pinning is a dashboard default; the API attaches explicitly), decrypted at runtime.

## Authentication

All API requests require your admin key as a Bearer token:

```
Authorization: Bearer hbr_adm_<your_key>
```

The key acts as the user who created it — all actions are attributed to that user, and your access mirrors theirs. An instance admin reaches every org; an org member reaches only their orgs, at their role (`editor` or `viewer`). Endpoints marked **instance admin** below return 403 for everyone else.

## Input validation & errors

Every mutation endpoint validates its input before touching the database, so you either succeed or get a clear rejection — there's no silent third outcome where a malformed value is stored.

- **Send a JSON object body.** Set `Content-Type: application/json` and send a top-level object (`{ ... }`). A malformed/empty body, a non-JSON body, or a top-level array/string/number is a **400** `{ "error": "..." }` — never a 500. (Where the wire contract allows a bare array — only the row-insert endpoint `POST /api/tables/:id/rows` — that's called out at the endpoint.)
- **Required fields and types are enforced.** A required field that's missing or empty, a string field given an object, an integer field given `"30m"`, an array field given a string, or an unknown enum value (e.g. an invalid `cli` or column `type`) all return **400** with a human-readable message naming the offending field. Wrong-typed values are rejected, never coerced and stored.
- **Error envelope.** All errors are `{ "error": "<message>" }`. Status codes: `400` bad input, `401` unauthenticated, `403` forbidden/out-of-scope (a resource in another tenant resolves to 403/404 rather than leaking its existence), `404` not found, `409` conflict (a name-slug collision, or an illegal run-status edge such as killing a non-running run), `429` rate-limited.

The practical contract: submit correctly and the call succeeds, or submit wrong and the response tells you exactly what to fix.

## Scope: Orgs and Projects

List and create endpoints are scoped by query param — `?orgId=<id>` for org-scoped resources (runs, jobs, docs, tables, env vars, projects) and `?projectId=<id>` for project-level ones (agents). Requests without the scope param return 403. Resource-by-id endpoints (`/api/jobs/:id`, etc.) need no scope param — access is checked against the resource's owning org.

Discover your scope first:

```
GET /api/auth/me    → { "type": "user", "user": {...}, "orgs": [...] }
GET /api/projects?orgId=<id>
```

### Create an Org (instance admin)
```
POST /api/orgs
Content-Type: application/json

{ "name": "Acme", "timezone": "America/New_York" }
```
`timezone` is optional and stored in the org's settings.

Org names must be unique instance-wide ignoring case and punctuation — at creation the org gets an immutable slug from its name (e.g. `Acme Corp` → `acme-corp`, used as a workspace path segment on runner machines), and a name whose slug collides with an existing org's returns 409 ("Acme Corp" and "acme_corp" are the same slug). A name with no letters or numbers at all returns 400. Renaming later never changes the slug.

### Update an Org
```
PUT /api/orgs?orgId=<id>    { "name": "...", "settings": { "timezone": "..." } }
```
Settings are merged with the existing values, not replaced.

### List / Create Projects
```
GET  /api/projects?orgId=<id>
POST /api/projects?orgId=<id>    { "name": "Marketing" }
```

Project names are unique per org, under the same slug rules as orgs — 409 on collision, 400 for a name with no letters or numbers.

### Get / Update / Archive a Project
```
GET    /api/projects/:id
PUT    /api/projects/:id    { "name": "New Name" }
DELETE /api/projects/:id
```

DELETE archives the project (soft delete) — its agents, jobs, and resources are kept but hidden.

## Agents

### List Agents
```
GET /api/agents?projectId=<id>
```

### Create an Agent
```
POST /api/agents?projectId=<id>
Content-Type: application/json

{
  "name": "Social Media Bot",
  "description": "Posts content and monitors engagement",
  "cli": "claude"
}
```

`name` and `cli` are required. `cli` is `claude`, `codex`, or `gemini`. Agent names are unique per project, under the same slug rules as orgs and projects — 409 on collision, 400 for a name with no letters or numbers. Optional fields:
- `model`, `thinking` — model and effort/reasoning level for the CLI (defaults apply if omitted). `model` is **not** validated — any string is accepted, since the CLIs take arbitrary model ids. `thinking` **is** validated per CLI — `low`/`medium`/`high`/`xhigh`/`max` for `claude`, `low`/`medium`/`high`/`xhigh` for `codex`, none for `gemini` (it takes no thinking level); an unknown level is a 400. Empty/omitted means the CLI default.
- `eager` (boolean) — **legacy/no-op.** Still accepted and stored for compatibility, but the unified runner drains all due work each cycle regardless, so it no longer changes behavior. Omit it.
- `placement` (string) — routes this agent's runs to a runner. Defaults to `local`: the auto-provisioned local runner claims the work. Set a label (e.g. `gpu`) to pin the agent to a specific machine — its runs then go only to a remote runner enrolled for that label (mint one via `POST /api/runners` and connect it on that host; see **Runners** below).
- `color` — identity hue (falls back to a name-derived color if omitted)

The response is the created agent record. The agent's runs are executed by a runner per its `placement` (the local runner by default, or a remote one you've enrolled for its label); the worker contract a runner reads is served at `GET /api/guide`.

### Get / Update / Delete an Agent
```
GET    /api/agents/:id
PUT    /api/agents/:id    { "name": "...", "description": "...", "cli": "...", "model": "...", "thinking": "...", "color": "...", "placement": "local" }
DELETE /api/agents/:id
```

PUT accepts any subset of `name`, `description`, `cli`, `model`, `thinking`, `color`, `eager`, `placement` — omitted fields are left unchanged. `model` is **not** validated (the CLIs accept arbitrary model ids); `thinking` is validated per `cli` (same per-CLI values as create). `cli` and `thinking` are validated together — changing `cli` to one that doesn't accept the agent's current `thinking` level is a 400 unless the request also re-sets or clears `thinking`.

### List Agent's Jobs
```
GET /api/agents/:id/jobs
```

## Runners (instance admin)

A **runner** is the process that claims and executes runs — both agent runs and workflows. The registry is instance-level (execution is org-agnostic). The **local** runner is auto-provisioned at setup and claims all `local`-placement work; you only mint a runner here to add a **remote** one on another machine, so that agents/workflows with a matching `placement` label land there.

### List Runners
```
GET /api/runners
```

### Mint a Runner
```
POST /api/runners
Content-Type: application/json

{ "name": "gpu-box", "labels": ["gpu"], "scope": { "orgId": "uuid" } }
```

Only `name` is required. `labels` (array of strings) are the placement labels the runner is authorized to serve — an agent/workflow whose `placement` matches one of them routes to it. `scope` is optional `{ "orgId"?, "agentId"? }` to restrict the token to one org and/or one agent's work. The response includes the runner row plus a ready-made `connect` command — `npm run harbour-agent -- connect <blob>`, for the standalone [harbour-agent](https://github.com/geekforbrains/harbour-agent) runner — to run on the remote host, where the base64 blob carries the URL, token, and name. The token is shown only here.

### Revoke a Runner
```
DELETE /api/runners/:id
```
Deleting the row invalidates the token immediately (its next claim 401s).

## Jobs

> **Pinning is a dashboard convenience, not an API behavior.** When you create a job over the API, docs/tables/secrets attach *only* if you pass them explicitly — `docIds` / `envVarIds` / `tableIds` on the create call, or `POST /api/jobs/:id/{docs,env-vars,tables}` afterward. The `pinned` flag merely pre-selects items in the dashboard's New Job dialog; it has no server-side effect, so an API-created job ignores it. The run payload is assembled purely from the job's junction rows. See [shared context › pinning](concepts/shared-context.md#pinning).

### List Jobs
```
GET /api/jobs?orgId=<id>
GET /api/jobs?orgId=<id>&projectId=<id>
```

Without `projectId`, returns the org's org-level workflows only; with it, the project's jobs plus the org-level workflows.

### Create an Agent Job
```
POST /api/agents/:id/jobs
Content-Type: application/json

{
  "name": "Morning Tweet",
  "instructions": "Write an engaging tweet about...",
  "schedule": "{\"every\":60}"
}
```

Only `name` and `schedule` are required — `instructions` is optional. `schedule` must be a string — either canonical JSON (e.g. `"{\"every\":60}"` or `"{\"days\":[1,2,3,4,5],\"time\":\"09:00\"}"`) or a human-readable form like `"every 5 minutes"`, `"daily at 9am"`, `"weekly on friday at 9am"` (full rules under **Schedule Format** below).

Optional fields: `instructions`, `prerun` (a **gate** run before the agent — exit 0 passes stdout to agent, exit 77 skips, other fails), `postrun` (a gate run after the run finishes), `postrunGates` (boolean — when true the postrun verifies the work: it runs after `done` only, and a nonzero exit flips the run to `failed`; when false it's informational, running on any terminal outcome without changing status), `model`, `thinking` (override of the agent's level, validated against the agent's `cli` — same per-CLI values as agent create), `titleFormat` (e.g. `"Issue #XXX — short summary"`; agents are instructed to follow it when setting each run's title), `description`, `docIds`, `envVarIds`, `tableIds`, `active` (defaults to true; set `false` to create the job paused). The `timeout_minutes` field defaults to 30 and is only settable via `PUT /api/jobs/:id` (as `timeoutMinutes`).

A gate is an object `{ "runtime": "bash" | "python" | "node", "content": "<script body>" }` — the runtime selects the interpreter (`bash`, `python3`, or `node`) and `content` is the full script source, stored verbatim. `runtime` is optional and defaults to `"bash"`; `content` is required and non-empty (else 400). The runner materializes each gate's body to its own file and executes it — there are no separate script files or bare-filename references.

```json
{
  "name": "Triage Issues",
  "instructions": "Triage new GitHub issues...",
  "schedule": "{\"every\":60}",
  "prerun": { "runtime": "python", "content": "import sys\n# exit 77 to skip when there's no work\nsys.exit(77)\n" }
}
```

### Create a Workflow (No Agent)
```
POST /api/jobs?orgId=<id>
Content-Type: application/json

{
  "name": "Health Check",
  "description": "Check API health every hour",
  "schedule": "{\"every\":60}",
  "command": { "runtime": "python", "content": "import urllib.request\nurllib.request.urlopen('https://example.com/health')\n" }
}
```

`name`, `schedule`, and `command` are all required. `command` is a **gate** — `{ "runtime": "bash" | "python" | "node", "content": "<script body>" }`, same shape as an agent job's prerun/postrun (`runtime` optional, defaults to `"bash"`; `content` required and non-empty). `workflow` is accepted as an alias for `command`. Workflows don't belong to an agent — passing `agentId` here returns 400 (agent jobs go through `POST /api/agents/:id/jobs`). `projectId` is optional (body or query) — with it the workflow is project-level; without it, **org-level**, claimed by any eligible runner. Scope is fixed at creation — re-create the job to change it. An org-level workflow may link only org-level docs/env vars/tables; a project-scoped id returns 400. Optional fields: `timeoutMinutes`, `docIds`, `envVarIds`, `tableIds`. The runner materializes the command's body to a file under `~/.harbour/workflows/` and runs it with the runtime's interpreter, pipes the run payload to stdin, and marks the run done/skipped/failed based on exit code (0 = done, 77 = skip, other = fail). Workflows are claimed by the same unified runner that handles agent runs — no separate credential. A workflow's `placement` (default `local`) routes it like an agent's: the auto-provisioned local runner picks up `local` work, and a label pins it to a remote runner enrolled for that label (see **Runners**).

### Schedule Format

The `schedule` field is always a **string**. It can be canonical JSON (string-encoded) or a human-readable phrase — both are normalized to canonical JSON when stored.

**Interval** — run every N minutes:
```json
"schedule": "{\"every\": 5}"
```

**Weekly** — run on specific days at a specific time:
```json
"schedule": "{\"days\": [1, 2, 3, 4, 5], \"time\": \"09:00\"}"
```

For the interval form, `every` must be a **positive integer of minutes**. For the weekly form, `days` is an array of 0 (Sunday) through 6 (Saturday) and `time` is zero-padded 24-hour `HH:MM`.

Human-readable strings are also accepted:
- `"every 5 minutes"` → `{"every": 5}`
- `"hourly"` → `{"every": 60}`
- `"daily at 9am"` → `{"days": [0,1,2,3,4,5,6], "time": "09:00"}`
- `"weekly on friday at 9am"` → `{"days": [5], "time": "09:00"}`

And the three narrow cron forms (other cron expressions are **not** parsed):
- `*/N * * * *` → every N minutes
- `0 */N * * *` → every N hours
- `M H * * DOW` → at `H:M` on the given day(s)-of-week (`DOW` may be `*`, a single digit, a comma list, or a `d-d` range)

Anything the parser can't map to one of these shapes — including a `schedule` passed as a JSON object instead of a string — returns a clean **400** with an explanatory `{ error }`.

### Get / Update / Delete a Job
```
GET    /api/jobs/:id
PUT    /api/jobs/:id    { "name": "...", "instructions": "...", "schedule": "...", "active": true, "timeoutMinutes": 30 }
DELETE /api/jobs/:id
```

PUT accepts: `name`, `description`, `instructions`, `schedule` (string, same formats as create), `prerun`/`postrun`/`postrunGates` (agent jobs), `command` (workflows; `workflow` alias accepted), `model`, `thinking` (agent jobs only, validated against the agent's `cli`), `titleFormat`, `timeoutMinutes` (camelCase), `placement` (workflows), `docIds`, `envVarIds`, `tableIds`, `active`, `nextRunAt`. `prerun`, `postrun`, and `command` are each a gate object `{ runtime, content }` or `null` — passing the gate object replaces it, `null` clears it, and omitting the field leaves it unchanged. Scope is not updatable — a job can't move between org-level and project-level. To pause a job, set `active: false`; to resume, `active: true`.

### Trigger a Job Immediately
```
POST /api/jobs/:id/trigger
Content-Type: application/json

{ "instructions": "Optional extra instructions for this run" }
```
Creates a run in `scheduled` status with `scheduled_for` set to now, regardless of the job's schedule — the assigned agent or an eligible runner claims it on its next poll (not an instant in-process execution). Body is optional; any `instructions` are appended to the run's activity log. Returns `{ "jobId": "...", "runId": "..." }` with status 201. This is also the way to run something ad hoc — there is no standalone "create run" endpoint; every run comes from a job.

### Link Resources to a Job
```
POST   /api/jobs/:id/docs                  { "docId": "uuid" }
POST   /api/jobs/:id/env-vars              { "envVarId": "uuid" }
POST   /api/jobs/:id/tables                { "tableId": "uuid" }
DELETE /api/jobs/:id/docs/:docId
DELETE /api/jobs/:id/env-vars/:envVarId
DELETE /api/jobs/:id/tables/:tableId
```

Each POST returns `{ "ok": true }` (the `docs` and `tables` routes use status 201; the `env-vars` route uses status 200). The body field is required and must be a non-empty string id, else 400.

Two distinct rejections, by cause:
- A resource in a **different org** than the job → **404** (it's treated as not found, never leaking cross-tenant existence).
- A tier violation — an **org-level job linking a project-level resource** → **400** with a message like "Org-level jobs can only link org-level …". An org-level (workflow) job may link only org-level docs/env vars/tables.

### List a Job's Runs
```
GET /api/jobs/:id/runs
```

## Runs

### List Runs
```
GET /api/runs?orgId=<id>
GET /api/runs?orgId=<id>&filter=waiting
GET /api/runs?orgId=<id>&filter=recent
GET /api/runs?orgId=<id>&projectId=<id>
```

Default returns all active runs grouped by status. `filter=waiting` returns runs needing human input. `filter=recent` returns recently completed runs. `projectId` narrows any of these to one project (runs of org-level workflows are still included).

### Run History (paginated, filterable)
```
GET /api/runs/history?orgId=<id>&limit=25&offset=0&sort=newest
```
Flat, paginated run history for the org — unlike `GET /api/runs`, which buckets only active/recent runs. Query params (all optional):
- `status` — comma-separated list (`scheduled,running,waiting,pending,done,failed,killed,skipped`). Omitted → all statuses **except** `skipped`.
- `includeSkipped=1` — include `skipped` runs (only meaningful when `status` is omitted).
- `agentId`, `jobId`, `projectId` — narrow to one agent / job / project (a `projectId` filter still includes org-level runs).
- `from`, `to` — unix-second bounds (inclusive).
- `sort` — `newest` (default) or `oldest`.
- `limit` (default 25), `offset` (default 0).

Returns `{ "runs": [...], "hasMore": <bool>, "nextOffset": <number|null> }` — pass `nextOffset` back as `offset` to page.

### Get a Run
```
GET /api/runs/:id
```
Returns the run with its full activity log.

### Get Run Activity
```
GET /api/runs/:id/activity
```

### Post Activity (as admin/human)
```
POST /api/runs/:id/activity
Content-Type: application/json

{ "content": "Here's the info you asked for: ...", "attachment_ids": ["uuid", ...] }
```

Use this to respond to a run. Posting to a run in `waiting`, `done`, `failed`, or `killed` status automatically transitions it to `pending` — the agent resumes it (with the full activity history) on its next poll. `skipped` runs are not comment-resumable; requeue them via retry. `attachment_ids` is optional — upload attachments first, then reference them here.

Workflow runs have no message thread — their activity log is runner output only, and posting to it returns 400.

### Retry a Failed/Skipped/Killed Run
```
POST /api/runs/:id/retry
```
Only works for runs whose status is `failed`, `skipped`, or `killed` — other statuses return 400. An agent run transitions back to `pending` for the agent to pick up; a workflow run is requeued as `scheduled` for a runner to claim.

### Kill a Running Run
```
POST /api/runs/:id/kill
```
Only works on a run in `running` status — any other status returns **409**. For a running run it sets the kill flag and returns 200 `{ "ok": true, "kill_requested": true }`, and records a "Kill requested" system activity entry. The kill flag is advisory: the agent/runner polls for it and stops its child process. An external HTTP client that never polls the flag simply won't be interrupted, but the call still succeeds. Commenting on a killed agent run resumes the CLI session where it left off; a killed workflow run is re-run via retry.

### Delete a Run
```
DELETE /api/runs/:id
```
Removes the run and its attachments. Returns `{ "success": true }` (this route's success envelope is `success`, not the `{ ok: true }` most other deletes use).

### Attachments

Attach files or video URL embeds (Loom/YouTube/Vimeo) to a run. Both kinds show up in the activity thread and in the run payload a runner gets from `POST /api/runner/claim`.

**Upload a file:**
```
POST /api/runs/:id/attachments
Content-Type: multipart/form-data

(part name "file" — any number of files in one request)
```

**Attach an embed URL:**
```
POST /api/runs/:id/attachments
Content-Type: application/json

{ "url": "https://www.loom.com/share/abc123", "title": "Walkthrough" }
```

**List/delete/download:**
```
GET    /api/runs/:id/attachments
DELETE /api/runs/:id/attachments/:aid
GET    /api/runs/:id/attachments/:aid/file
```

Per-file size cap is set by the server's `HARBOUR_MAX_UPLOAD_MB` (default 500MB).

## Docs

### List Docs
```
GET /api/docs?orgId=<id>
GET /api/docs?orgId=<id>&projectId=<id>
```

### Create a Doc
```
POST /api/docs
Content-Type: application/json

{ "title": "Brand Guidelines", "content": "## Voice\n...", "projectId": "uuid" }
```

`projectId` is optional — with it the doc is project-level; without it the doc is org-level, shared across the org's projects (org scope comes from `?orgId=<id>` when no project is given).

### Get / Update / Delete a Doc
```
GET    /api/docs/:id
PUT    /api/docs/:id    { "title": "...", "content": "..." }
DELETE /api/docs/:id
```

A doc's content is revision-backed: each `PUT` appends a new revision and the latest revision is the live content `GET` returns.

### Doc Revisions
```
GET /api/docs/:id/revisions
```
Returns the doc's full revision history, newest first — one entry per `PUT`, each with its content and author.

### Pin/Unpin a Doc
```
POST /api/docs/:id/pin
```
Toggles pinned status. Pinning is a **dashboard** default: the New Job dialog pre-checks pinned docs in scope (an org-level doc for every project in the org, a project-level one for that project) so new jobs pick them up unless deselected. It has no effect on jobs created via the API — those link only the `docIds` you pass.

## Tables

### List Tables
```
GET /api/tables?orgId=<id>
GET /api/tables?orgId=<id>&projectId=<id>
```

### Create a Table
```
POST /api/tables
Content-Type: application/json

{
  "name": "metrics",
  "columns": [
    { "name": "date", "type": "TEXT", "required": true },
    { "name": "value", "type": "REAL" }
  ]
}
```

Column `type` must be one of `TEXT`, `INTEGER`, `REAL` (case-insensitive — anything else is a 400). Every table gets an auto-incrementing `_id` column. `projectId` is optional (body or query) — without it the table is org-level. If a table with that name already exists in scope, the existing one is returned instead of creating a duplicate.

**Name sanitization (applies to both the table name and every column name):** names are lowercased, every non-`[a-z0-9_]` character becomes `_`, runs of `_` collapse, leading/trailing `_` are stripped, and the result is truncated to 64 chars — so `"Daily Metrics!"` is stored as `daily_metrics`. A name that sanitizes to empty (no letters or digits) is a 400, as is one that collides with a SQLite reserved word (e.g. `order`, `select`, `group`). A column may not be named `_id` (reserved). At create time a `required: true` column needs no `default` (the table starts empty); adding a required column to an *existing* table later does — see **Add a Column** below.

### Get / Delete a Table
```
GET    /api/tables/:id
DELETE /api/tables/:id
```

### Add a Column
```
POST /api/tables/:id/columns
Content-Type: application/json

{ "name": "new_field", "type": "TEXT", "default": "" }
```
`name` and `type` are required (`type` allow-listed and sanitized exactly as on create). Adding a `required: true` column to an existing table **must** include a `default` — SQLite can't add a NOT NULL column to a populated table without one — otherwise 400.

### Insert Rows
```
POST /api/tables/:id/rows
Content-Type: application/json

[
  { "date": "2024-03-01", "value": 42.5 },
  { "date": "2024-03-02", "value": 38.1 }
]
```

### Read Rows
```
GET /api/tables/:id/rows?limit=100&offset=0&orderBy=date&order=DESC
```
All query params are optional. Defaults: `limit=100`, `offset=0`, `order=DESC`. With no `orderBy` the rows come back newest-first by insertion order (`rowid DESC`); supplying an `orderBy` that isn't a real column is a 400. Returns `{ "rows": [...], "total": <count>, "limit": ..., "offset": ... }`.

### Update / Delete a Row
```
PUT    /api/tables/:id/rows/:rowId    { "value": 99.9 }
DELETE /api/tables/:id/rows/:rowId
```

### Pin/Unpin a Table
```
POST /api/tables/:id/pin
```
Toggles pinned status. Pinning is a dashboard default — the New Job dialog pre-checks pinned tables in scope; it has no effect on API-created jobs (which link only the `tableIds` you pass). Same model as pinned docs and env vars.

## Environment Variables

### List Env Vars
```
GET /api/env-vars?orgId=<id>
GET /api/env-vars?orgId=<id>&projectId=<id>
```

### Create an Env Var
```
POST /api/env-vars
Content-Type: application/json

{ "name": "GITHUB_TOKEN", "value": "ghp_...", "projectId": "uuid" }
```

Both `name` and `value` are **required and non-empty** — you cannot create an empty-value secret (a blank or missing `value` is a 400). `projectId` is optional — without it the env var is org-level (org scope from `?orgId=<id>`).

### Get / Update / Delete an Env Var
```
GET    /api/env-vars/:id
PUT    /api/env-vars/:id    { "name": "...", "value": "..." }
DELETE /api/env-vars/:id
```

`GET /api/env-vars/:id` does not include the value. Both list and detail responses only return metadata.

### Read the Decrypted Value
```
GET /api/env-vars/:id/value
```
Returns `{ "value": "..." }`. Requires **editor** role on the owning org — viewers are rejected with 403.

### Pin/Unpin an Env Var
```
POST /api/env-vars/:id/pin
```
Toggles pinned status. Pinning is a dashboard default — the New Job dialog pre-checks pinned env vars in scope; it has no effect on API-created jobs (which link only the `envVarIds` you pass). Same model as pinned docs.

## Settings (instance admin)

### Get All Settings
```
GET /api/settings
```
Sensitive values come back masked.

### Update Settings
```
PUT /api/settings
Content-Type: application/json

{ "timezone": "America/New_York", "recent_runs_limit": "20" }
```

Values are strings. `timezone` is the default schedule timezone; `recent_runs_limit` caps the dashboard's recent-runs list; `recent_collapse_success` (`"true"`/`"false"`, default on) folds a job's repeated successful runs into one row on that list. Per-org timezone is set via `PUT /api/orgs?orgId=<id>`.

### List Timezones
```
GET /api/settings/timezones
```

## Users (instance admin)

### List Users
```
GET /api/users
```
Returns all users with their org memberships and a `pending` flag (true until the user sets a password).

### Create a User
```
POST /api/users
Content-Type: application/json

{ "email": "ana@example.com", "displayName": "Ana", "isInstanceAdmin": false }
```
Users are created without a password — mint a set-password link next.

### Set-Password Link
```
POST /api/users/:id/set-password-link
```
Returns `{ "token": "...", "url": "...", "expiresAt": ... }` — a single-use onboarding/reset link, shown only once. Hand it to the user out of band.

### Update / Delete a User
```
PUT    /api/users/:id    { "displayName": "...", "isInstanceAdmin": true }
DELETE /api/users/:id
```

### Org Members
```
GET    /api/orgs/:id/members
POST   /api/orgs/:id/members    { "userId": "uuid", "role": "editor" }
DELETE /api/orgs/:id/members/:userId
```
POST also changes an existing member's role (`editor` or `viewer`). Instance admins already span every org and cannot hold explicit memberships.

## Admin API Keys (instance admin)

You can manage other admin keys (create keys for other agents, revoke access).

### List Keys
```
GET /api/admin-api-keys
```

### Create a Key
```
POST /api/admin-api-keys
Content-Type: application/json

{ "name": "My other agent" }
```

Returns `{ "id": "...", "name": "...", "apiKey": "hbr_adm_..." }` — save the key, shown only once.

### Delete a Key
```
DELETE /api/admin-api-keys/:id
```

## Common Workflows

### Set up a new agent with a recurring job
1. `GET /api/auth/me` — find your org; `GET /api/projects?orgId=<id>` — pick a project (or `POST /api/projects?orgId=<id>` to create one)
2. `POST /api/agents?projectId=<id>` — create the agent (name + cli). The agent has no credential of its own; nothing to save
3. `POST /api/agents/:id/jobs` — create a job with schedule and instructions
4. `POST /api/docs` — create any docs the agent needs
5. `POST /api/jobs/:id/docs` — link docs to the job
6. `POST /api/env-vars` — create env vars (API keys, tokens)
7. `POST /api/jobs/:id/env-vars` — link env vars to the job
8. No runner setup needed for the default `local` placement — the auto-provisioned local runner claims the agent's runs and the spawned CLI authenticates per-run with the run's exec token. To pin the agent to another machine, give it a `placement` label and mint a remote runner for that label (see **Runners**)

### Set up a workflow (no agent)
1. `POST /api/jobs?orgId=<id>` — create the workflow with `command` (a `{ runtime, content }` gate) and schedule (add `projectId` for project-level)
2. No runner setup needed for `local` placement — the auto-provisioned local runner claims it. To pin it to another machine, give the workflow a `placement` label and `POST /api/runners` to mint a remote runner for that label, then run the returned `connect` command on that host
3. Optionally link docs/env vars for context (passed via stdin JSON)

### Respond to a waiting run
1. `GET /api/runs?orgId=<id>&filter=waiting` — find runs needing input
2. `GET /api/runs/:id` — read the activity log to understand what the agent needs
3. `POST /api/runs/:id/activity` — post your response (auto-transitions to `pending`)

### Check system status
1. `GET /api/agents?projectId=<id>` — see a project's agents and their poll status
2. `GET /api/runs?orgId=<id>` — see active, waiting, and recent runs
3. `GET /api/runs?orgId=<id>&filter=waiting` — see what needs human attention
