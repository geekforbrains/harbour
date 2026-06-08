# Harbour Admin Guide

This document covers everything an admin agent needs to manage a Harbour instance. It is served at `GET /api/admin-guide`.

## Overview

You have full admin access to a Harbour instance — the control plane for AI agents doing ongoing work. You can create and manage agents, jobs, runs, docs, databases, env vars, projects, and settings. You are not a worker agent polling for runs — you are a management layer that helps a human operate Harbour through the API.

Key concepts:
- **Agents** — workers that poll for and execute runs. External agents use API keys; harbour agents use built-in CLI tools.
- **Jobs** — recurring responsibilities. Agent jobs are assigned to an agent with instructions and can have prerun commands. Workflow jobs run shell commands with no agent or LLM.
- **Runs** — a single execution of a job (or a one-off task). Agents claim runs and post activity updates.
- **Docs** — shared markdown documents injected into runs automatically.
- **Databases** — SQLite tables agents create and manage, injected into runs.
- **Env Vars** — encrypted key-value pairs (API keys, tokens) decrypted at runtime.
- **Projects** — optional groupings to organize agents, jobs, docs, env vars, and databases.

## Authentication

All API requests require your admin key as a Bearer token:

```
Authorization: Bearer hbr_adm_<your_key>
```

This key gives you full user-level access. All actions are attributed to the user who created the key.

## Agents

### List Agents
```
GET /api/agents
GET /api/agents?projectId=<id>
```

### Create an Agent
```
POST /api/agents
Content-Type: application/json

{
  "name": "Social Media Bot",
  "description": "Posts content and monitors engagement",
  "type": "external"
}
```

Type is `external` (default) or `harbour` (requires `cli`, `model`, `thinking` fields). Harbour agents also accept an optional `eager` boolean — when true, the local runner drains the queue back-to-back instead of waiting 60s between runs. Off by default. Failed/killed runs always exit the eager loop.

Response includes `apiKey` — save it, shown only once. Give this key and the agent's invite text to the worker agent.

### Get / Update / Delete an Agent
```
GET    /api/agents/:id
PUT    /api/agents/:id    { "name": "New Name", "description": "...", "eager": true }
DELETE /api/agents/:id
```

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
GET /api/jobs
GET /api/jobs?projectId=<id>
```

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

Optional fields: `prerunCommand` (shell command run before the agent — exit 0 passes stdout to agent, exit 77 skips, other fails), `model`, `thinking`, `titleFormat` (e.g. `"Issue #XXX — short summary"`; agents are instructed to follow it when setting each run's title), `description`, `docIds`, `envVarIds`. The `timeout_minutes` field defaults to 30 and is only settable via `PUT /api/jobs/:id` (as `timeoutMinutes`).

### Create a Workflow (No Agent)
```
POST /api/jobs
Content-Type: application/json

{
  "name": "Health Check",
  "description": "Check API health every hour",
  "schedule": "{\"every\":60}",
  "command": "python3 check_health.py"
}
```

Workflows don't belong to an agent. A workflow runner executes the command in `~/.harbour/workflows/`, pipes the run payload to stdin, and marks the run done/skipped/failed based on exit code (0 = done, 77 = skip, other = fail).

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

PUT accepts: `name`, `description`, `instructions`, `schedule` (string, same formats as create), `prerunCommand` (agent jobs), `command` (workflows), `model`, `thinking`, `titleFormat`, `timeoutMinutes` (camelCase), `docIds`, `envVarIds`, `active`, `nextRunAt`. To pause a job, set `active: false`; to resume, `active: true`.

### Trigger a Job Immediately
```
POST /api/jobs/:id/trigger
Content-Type: application/json

{ "instructions": "Optional extra instructions for this run" }
```
Creates and queues a run immediately, regardless of schedule. Body is optional. Returns `{ "jobId": "...", "runId": "..." }` with status 201.

### Link Resources to a Job
```
POST   /api/jobs/:id/docs                  { "docId": "uuid" }
POST   /api/jobs/:id/env-vars              { "envVarId": "uuid" }
POST   /api/jobs/:id/data                  { "databaseId": "uuid" }
DELETE /api/jobs/:id/docs/:docId
DELETE /api/jobs/:id/env-vars/:envVarId
DELETE /api/jobs/:id/data/:dataId
```

## Runs

### List Runs
```
GET /api/runs
GET /api/runs?filter=waiting
GET /api/runs?filter=recent
GET /api/runs?projectId=<id>
```

Default returns all active runs grouped by status. `filter=waiting` returns runs needing human input. `filter=recent` returns recently completed runs.

### Create a One-Off Run
```
POST /api/runs
Content-Type: application/json

{
  "agentId": "uuid",
  "name": "Quick analysis",
  "instructions": "Analyze the latest metrics and report back",
  "docIds": ["uuid"],
  "envVarIds": ["uuid"]
}
```

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

Use this to respond to runs in `waiting` status. The run automatically transitions to `pending` when you post a response. `attachment_ids` is optional — upload attachments first, then reference them here.

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
Only works for runs in `running` status handled by a runner — `harbour`-type agent runs and workflow runs. External-agent runs and non-running statuses return 400/409. The runner polls for the kill flag and stops its child process; commenting on a killed agent run resumes the CLI session where it left off, while a killed workflow run is re-run via retry.

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
GET /api/docs
GET /api/docs?projectId=<id>
```

### Create a Doc
```
POST /api/docs
Content-Type: application/json

{ "title": "Brand Guidelines", "content": "## Voice\n..." }
```

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
Toggles pinned status. Pinned docs are auto-attached to all new jobs and one-off runs.

## Databases

### List Databases
```
GET /api/databases
GET /api/databases?projectId=<id>
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

Column types: `TEXT`, `INTEGER`, `REAL`. Every table gets an auto-incrementing `_id` column.

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
GET /api/env-vars
GET /api/env-vars?projectId=<id>
```

### Create an Env Var
```
POST /api/env-vars
Content-Type: application/json

{ "name": "GITHUB_TOKEN", "value": "ghp_..." }
```

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
Returns `{ "value": "..." }`. Requires user-level auth — agent API keys are rejected with 403.

### Pin/Unpin an Env Var
```
POST /api/env-vars/:id/pin
```
Toggles pinned status. Pinned env vars are auto-attached to all new jobs and one-off runs.

## Projects

Projects are optional groupings. Entities live at the top level and can belong to multiple projects.

### List / Create Projects
```
GET  /api/projects
POST /api/projects    { "name": "Marketing" }
```

### Get / Update / Delete a Project
```
GET    /api/projects/:id
PUT    /api/projects/:id    { "name": "New Name" }
DELETE /api/projects/:id
```

Deleting a project only removes the grouping — nothing else is affected.

### Link / Unlink Entities
```
PATCH /api/projects/:id
Content-Type: application/json

{ "action": "link", "type": "agent", "targetId": "uuid" }
{ "action": "unlink", "type": "job", "targetId": "uuid" }
```

Valid types: `agent`, `job`, `doc`, `env-var`, `database`.

Adding a job to a project auto-links its agent, docs, env vars, and databases.

## Settings

### Get All Settings
```
GET /api/settings
```

### Update Settings
```
PUT /api/settings
Content-Type: application/json

{ "timezone": "America/New_York", "signup_enabled": "false" }
```

### List Timezones
```
GET /api/settings/timezones
```

## Admin API Keys

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
1. `POST /api/agents` — create the agent, save the API key
2. `POST /api/agents/:id/jobs` — create a job with schedule and instructions
3. `POST /api/docs` — create any docs the agent needs
4. `POST /api/jobs/:id/docs` — link docs to the job
5. `POST /api/env-vars` — create env vars (API keys, tokens)
6. `POST /api/jobs/:id/env-vars` — link env vars to the job
7. Give the worker agent its API key and the Harbour URL

### Set up a workflow (no agent)
1. `POST /api/jobs` — create the workflow with `command` and schedule
2. Place the script in `~/.harbour/workflows/` on the runner host
3. Optionally link docs/env vars for context (passed via stdin JSON)

### Respond to a waiting run
1. `GET /api/runs?filter=waiting` — find runs needing input
2. `GET /api/runs/:id` — read the activity log to understand what the agent needs
3. `POST /api/runs/:id/activity` — post your response (auto-transitions to `pending`)

### Organize work into a project
1. `POST /api/projects` — create the project
2. `PATCH /api/projects/:id` — link agents, jobs, docs, env vars, databases

### Check system status
1. `GET /api/agents` — see all agents and their poll status
2. `GET /api/runs` — see active, waiting, and recent runs
3. `GET /api/runs?filter=waiting` — see what needs human attention
