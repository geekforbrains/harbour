# Harbour Admin Guide

This document covers everything an admin agent needs to manage a Harbour instance. It is served at `GET /api/admin-guide`.

## Overview

You have admin access to a Harbour instance — the control plane for AI agents doing ongoing work. You can create and manage orgs, projects, agents, jobs, runs, docs, databases, env vars, and settings. You are not a worker agent polling for runs — you are a management layer that helps a human operate Harbour through the API.

Key concepts:
- **Orgs** — top-level tenants. Every project belongs to an org; resources never cross org lines.
- **Projects** — containers inside an org. Every agent lives in exactly one project. Docs, databases, env vars — and workflow jobs — are either project-level or org-level (shared across the org's projects); agent jobs are always project-level.
- **Agents** — workers that poll for and execute runs. Each agent authenticates with its own API key; any HTTP client holding the key can do the work. The bundled runner drives Claude Code, Codex, or Gemini.
- **Jobs** — recurring responsibilities. Agent jobs are assigned to an agent with instructions and can have prerun/postrun commands. Workflow jobs run shell commands with no agent or LLM.
- **Runs** — a single execution of a job. Agents claim runs and post activity updates.
- **Docs** — shared markdown documents injected into runs automatically.
- **Databases** — SQLite tables agents create and manage, injected into runs.
- **Env Vars** — encrypted key-value pairs (API keys, tokens) decrypted at runtime.

## Authentication

All API requests require your admin key as a Bearer token:

```
Authorization: Bearer hbr_adm_<your_key>
```

The key acts as the user who created it — all actions are attributed to that user, and your access mirrors theirs. An instance admin reaches every org; an org member reaches only their orgs, at their role (`editor` or `viewer`). Endpoints marked **instance admin** below return 403 for everyone else.

## Scope: Orgs and Projects

List and create endpoints are scoped by query param — `?orgId=<id>` for org-scoped resources (runs, jobs, docs, databases, env vars, projects) and `?projectId=<id>` for project-level ones (agents). Requests without the scope param return 403. Resource-by-id endpoints (`/api/jobs/:id`, etc.) need no scope param — access is checked against the resource's owning org.

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
- `model`, `thinking` — model and effort/reasoning level for the CLI (defaults apply if omitted). `thinking` is validated per CLI — `low`/`medium`/`high`/`xhigh`/`max` for `claude`, `low`/`medium`/`high`/`xhigh` for `codex`, none for `gemini`; an unknown level is a 400. Empty/omitted means the CLI default.
- `eager` (boolean) — the runner drains the queue back-to-back instead of waiting 60s between runs. Off by default. Failed/killed runs always exit the eager loop.
- `remote` (boolean) — the runner lives on another machine. Local agents (the default) are registered with the co-located runner automatically; remote agents are connected on their machine via `npm run harbour -- agent connect`.
- `color` — identity hue (falls back to a name-derived color if omitted)

Response includes `apiKey` — save it, shown only once. Any HTTP client holding this key can act as the agent; the worker contract is served at `GET /api/guide`.

### Get / Update / Delete an Agent
```
GET    /api/agents/:id
PUT    /api/agents/:id    { "name": "...", "description": "...", "model": "...", "thinking": "...", "eager": true }
DELETE /api/agents/:id
```

Changes to `name`, `model`, `thinking`, or `eager` sync to the local runner config automatically. `cli` and `thinking` are validated together (same rules as create) — changing `cli` to one that doesn't accept the agent's current `thinking` level is a 400 unless the request also re-sets or clears `thinking`.

### Rotate Agent API Key
```
POST /api/agents/:id/rotate-key
```
Returns `{ "apiKey": "hbr_..." }` — the new key, shown only once.

### List Agent's Jobs
```
GET /api/agents/:id/jobs
```

## Jobs

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

`schedule` must be a string — either canonical JSON (e.g. `"{\"every\":60}"` or `"{\"days\":[1,2,3,4,5],\"time\":\"09:00\"}"`) or a human-readable form like `"every 5 minutes"`, `"daily at 9am"`, `"weekly on friday at 9am"`.

Optional fields: `prerunCommand` (shell command run before the agent — exit 0 passes stdout to agent, exit 77 skips, other fails), `postrunCommand` (shell command run after the run finishes), `postrunGates` (boolean — when true the postrun verifies the work: it runs after `done` only, and a nonzero exit flips the run to `failed`; when false it's informational, running on any terminal outcome without changing status), `model`, `thinking` (override of the agent's level, validated against the agent's `cli` — same per-CLI values as agent create), `titleFormat` (e.g. `"Issue #XXX — short summary"`; agents are instructed to follow it when setting each run's title), `description`, `docIds`, `envVarIds`. The `timeout_minutes` field defaults to 30 and is only settable via `PUT /api/jobs/:id` (as `timeoutMinutes`).

### Create a Workflow (No Agent)
```
POST /api/jobs?orgId=<id>
Content-Type: application/json

{
  "name": "Health Check",
  "description": "Check API health every hour",
  "schedule": "{\"every\":60}",
  "command": "python3 check_health.py"
}
```

Workflows don't belong to an agent — passing `agentId` here returns 400 (agent jobs go through `POST /api/agents/:id/jobs`). `projectId` is optional (body or query) — with it the workflow is project-level; without it, **org-level**, claimed by the same org-scoped workflow runners. Scope is fixed at creation — re-create the job to change it. An org-level workflow may link only org-level docs/env vars/databases; a project-scoped id returns 400. Optional fields: `timeoutMinutes`, `docIds`, `envVarIds`. A workflow runner executes the command in `~/.harbour/workflows/`, pipes the run payload to stdin, and marks the run done/skipped/failed based on exit code (0 = done, 77 = skip, other = fail). Runner credentials are minted with `POST /api/workflow-runners?orgId=<id>` `{ "name": "..." }` — the response includes a ready-made `npm run harbour -- workflow connect <blob>` command for the runner host.

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

Days are 0 (Sunday) through 6 (Saturday). Time is 24-hour `HH:MM`.

Human-readable strings are also accepted:
- `"every 5 minutes"` → `{"every": 5}`
- `"hourly"` → `{"every": 60}`
- `"daily at 9am"` → `{"days": [0,1,2,3,4,5,6], "time": "09:00"}`
- `"weekly on friday at 9am"` → `{"days": [5], "time": "09:00"}`
- A 5-field cron expression (`*/N * * * *`, `M H * * DOW`, etc.)

Passing the schedule as a JSON object (not a string) returns a 500.

### Get / Update / Delete a Job
```
GET    /api/jobs/:id
PUT    /api/jobs/:id    { "name": "...", "instructions": "...", "schedule": "...", "active": true, "timeoutMinutes": 30 }
DELETE /api/jobs/:id
```

PUT accepts: `name`, `description`, `instructions`, `schedule` (string, same formats as create), `prerunCommand`/`postrunCommand`/`postrunGates` (agent jobs), `command` (workflows), `model`, `thinking` (agent jobs only, validated against the agent's `cli`), `titleFormat`, `timeoutMinutes` (camelCase), `docIds`, `envVarIds`, `active`, `nextRunAt`. Scope is not updatable — a job can't move between org-level and project-level. To pause a job, set `active: false`; to resume, `active: true`.

### Trigger a Job Immediately
```
POST /api/jobs/:id/trigger
Content-Type: application/json

{ "instructions": "Optional extra instructions for this run" }
```
Creates and queues a run immediately, regardless of schedule. Body is optional. Returns `{ "jobId": "...", "runId": "..." }` with status 201. This is also the way to run something ad hoc — there is no standalone "create run" endpoint; every run comes from a job.

### Link Resources to a Job
```
POST   /api/jobs/:id/docs                  { "docId": "uuid" }
POST   /api/jobs/:id/env-vars              { "envVarId": "uuid" }
POST   /api/jobs/:id/data                  { "databaseId": "uuid" }
DELETE /api/jobs/:id/docs/:docId
DELETE /api/jobs/:id/env-vars/:envVarId
DELETE /api/jobs/:id/data/:dataId
```

An org-level workflow can link only org-level resources — a project-scoped doc/env var/database returns 400.

### Manage a Job's Scripts
```
GET    /api/jobs/:id/scripts
POST   /api/jobs/:id/scripts             { "filename": "check_health.py", "content": "...", "executable": true }
PUT    /api/jobs/:id/scripts/:scriptId   { "filename": "...", "content": "...", "executable": true }
DELETE /api/jobs/:id/scripts/:scriptId
```
Scripts hold the file contents the runner materializes before running the job's `command`/`prerunCommand`/`postrunCommand` — referenced by bare filename (e.g. `python3 check_health.py`, `./prerun.sh`). `filename` is required on `POST` and must be a bare name: 1–128 of `[A-Za-z0-9._-]`, no slashes, not `.`/`..` (otherwise 400). `content` defaults to `""` and `executable` to `true` (true → file written executable). `PUT` updates any subset of the three; an omitted field is left unchanged. `GET` returns the list ordered by filename; each record is `{ id, job_id, filename, content, executable (0|1), created_at, updated_at }`. `POST` returns the created record with status 201; `DELETE` returns `{ "ok": true }`. The script files are delivered in the run payload (`job.scripts` / `job.scripts_dir`) and written to disk per job by the runner.

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
Only works for runs whose status is `failed`, `skipped`, or `killed` — other statuses return 400. An agent run transitions back to `pending` for the agent to pick up; a workflow run is requeued as `scheduled` for a workflow runner to claim.

### Kill a Running Run
```
POST /api/runs/:id/kill
```
Only works for runs in `running` status handled by a runner — harbour-run agent runs and workflow runs. Runs driven by an external HTTP client (no runner polling the kill flag) and non-running statuses return 400/409. The runner polls for the kill flag and stops its child process; commenting on a killed agent run resumes the CLI session where it left off, while a killed workflow run is re-run via retry.

### Delete a Run
```
DELETE /api/runs/:id
```
Removes the run and its attachments.

### Attachments

Attach files or video URL embeds (Loom/YouTube/Vimeo) to a run. Both kinds show up in the activity thread and in the `/next` payload for agents.

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

### Pin/Unpin a Doc
```
POST /api/docs/:id/pin
```
Toggles pinned status. Pinned docs are auto-attached to new jobs created in their scope — an org-level pinned doc to every new job in the org, a project-level one to new jobs in that project.

## Databases

### List Databases
```
GET /api/databases?orgId=<id>
GET /api/databases?orgId=<id>&projectId=<id>
```

### Create a Database
```
POST /api/databases
Content-Type: application/json

{
  "name": "metrics",
  "columns": [
    { "name": "date", "type": "TEXT", "required": true },
    { "name": "value", "type": "REAL" }
  ]
}
```

Column types: `TEXT`, `INTEGER`, `REAL`. Every table gets an auto-incrementing `_id` column. `projectId` is optional (body or query) — without it the database is org-level. If a database with that name already exists in scope, the existing one is returned instead of creating a duplicate.

### Get / Delete a Database
```
GET    /api/databases/:id
DELETE /api/databases/:id
```

### Add a Column
```
POST /api/databases/:id/columns
Content-Type: application/json

{ "name": "new_field", "type": "TEXT", "default": "" }
```

### Insert Rows
```
POST /api/databases/:id/rows
Content-Type: application/json

[
  { "date": "2024-03-01", "value": 42.5 },
  { "date": "2024-03-02", "value": 38.1 }
]
```

### Read Rows
```
GET /api/databases/:id/rows?limit=50&offset=0&orderBy=date&order=DESC
```

### Update / Delete a Row
```
PUT    /api/databases/:id/rows/:rowId    { "value": 99.9 }
DELETE /api/databases/:id/rows/:rowId
```

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

`projectId` is optional — without it the env var is org-level (org scope from `?orgId=<id>`).

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
Returns `{ "value": "..." }`. Requires **editor** role on the owning org — viewers and agent API keys are rejected with 403.

### Pin/Unpin an Env Var
```
POST /api/env-vars/:id/pin
```
Toggles pinned status. Pinned env vars are auto-attached to new jobs created in their scope, same as pinned docs.

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

Values are strings. `timezone` is the default schedule timezone; `recent_runs_limit` caps the dashboard's recent-runs list. Per-org timezone is set via `PUT /api/orgs?orgId=<id>`.

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
2. `POST /api/agents?projectId=<id>` — create the agent (name + cli), save the API key
3. `POST /api/agents/:id/jobs` — create a job with schedule and instructions
4. `POST /api/docs` — create any docs the agent needs
5. `POST /api/jobs/:id/docs` — link docs to the job
6. `POST /api/env-vars` — create env vars (API keys, tokens)
7. `POST /api/jobs/:id/env-vars` — link env vars to the job
8. Give the worker agent its API key and the Harbour URL

### Set up a workflow (no agent)
1. `POST /api/jobs?orgId=<id>` — create the workflow with `command` and schedule (add `projectId` for project-level)
2. `POST /api/workflow-runners?orgId=<id>` — mint runner credentials; run the returned `workflow connect` command on the runner host
3. Place the script in `~/.harbour/workflows/` on the runner host
4. Optionally link docs/env vars for context (passed via stdin JSON)

### Respond to a waiting run
1. `GET /api/runs?orgId=<id>&filter=waiting` — find runs needing input
2. `GET /api/runs/:id` — read the activity log to understand what the agent needs
3. `POST /api/runs/:id/activity` — post your response (auto-transitions to `pending`)

### Check system status
1. `GET /api/agents?projectId=<id>` — see a project's agents and their poll status
2. `GET /api/runs?orgId=<id>` — see active, waiting, and recent runs
3. `GET /api/runs?orgId=<id>&filter=waiting` — see what needs human attention
