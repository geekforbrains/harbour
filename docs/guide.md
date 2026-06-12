# Harbour Agent Guide

This document covers everything an agent needs to work with Harbour. It is served at `GET /api/guide`.

## Overview

Harbour is a control plane that manages your recurring jobs, shared docs, data stores, and encrypted environment variables. It doesn't control how you do your work — it tells you *what* to do, *when*, and gives you the context to do it.

You poll for work. Harbour returns a job with instructions, referenced docs, database rows, and env vars. You do the work, log your activity, and mark it done — or set it to "waiting" if you need human input. Humans respond on the dashboard, and your next poll picks it up. You can also create and update shared docs and manage structured data through the API.

Key concepts:
- **Jobs** — recurring responsibilities with a schedule, instructions, and linked docs/data/env vars
- **Runs** — a single execution of a job, with an activity log of agent and human messages
- **Docs** — shared markdown documents, injected into runs automatically
- **Databases** — SQLite tables you create and manage, injected into runs automatically
- **Env Vars** — encrypted key-value pairs (API keys, tokens), decrypted and injected at runtime

## Scheduling

Jobs use the `schedule` field to define when they run. Harbour automatically computes `next_run_at` when a job is created, and advances it each time a run completes (status changes to `done`, `failed`, or `skipped`). You don't need to manage `next_run_at` yourself.

All schedule times use the system timezone configured in Settings (auto-detected from the server on first run).

**Choose the right schedule type for the job.** Most agent jobs should use short intervals (every few minutes), not weekly schedules. Use weekly/daily only for jobs that genuinely run on a calendar cadence (e.g. a weekly newsletter). For monitoring, triage, content posting, and most recurring work, use an interval.

### Schedule format

Schedules are JSON in one of two shapes:

**Interval** — run every N minutes:
```json
{"every": 5}
```

**Weekly** — run on specific days at a specific time:
```json
{"days": [1, 2, 3, 4, 5], "time": "09:00"}
```

Days are 0 (Sunday) through 6 (Saturday). Time is 24-hour `HH:MM`.

**Examples:**
- `{"every": 5}` — every 5 minutes (good default for most jobs)
- `{"every": 60}` — every hour
- `{"every": 1440}` — once a day
- `{"days": [1, 2, 3, 4, 5], "time": "09:00"}` — weekdays at 9am
- `{"days": [0, 1, 2, 3, 4, 5, 6], "time": "14:30"}` — daily at 2:30pm
- `{"days": [5], "time": "09:00"}` — Fridays at 9am

For convenience, the API also accepts human-readable strings and common cron expressions. These are automatically normalized to JSON on creation:
- `every 5 minutes` → `{"every": 5}`
- `daily at 9am` → `{"days": [0,1,2,3,4,5,6], "time": "09:00"}`
- `weekly on friday at 9am` → `{"days": [5], "time": "09:00"}`
- `*/5 * * * *` → `{"every": 5}`
- `0 9 * * 1-5` → `{"days": [1,2,3,4,5], "time": "09:00"}`

## Authentication

All API requests require a Bearer token in the Authorization header:

```
Authorization: Bearer hbr_<your_api_key>
```

API keys are issued when an agent is created and shown only once. Keys can be rotated from the dashboard.

## The Polling Loop

Agents pull work from Harbour on their own schedule. Harbour never calls out to agents.

### Get Next Work

```
GET /api/agents/:id/next
```

Returns the next thing for the agent to work on, or `null` if nothing to do.

**Priority order:**
1. Any stale `running` run past its job's timeout is automatically failed first
2. If the agent has a run in `running` status, returns `null` (agent is busy)
3. Any `pending` run (human responded, ready to resume) — resume it
4. Any `scheduled` run ready to start (triggered from the dashboard or `POST /api/jobs/:id/trigger`) — claim it
5. Any recurring job past its scheduled time without an active run — create a new run
6. Nothing to do — returns `null`

**Response format:**
```json
{
  "run": {
    "id": "uuid",
    "status": "running",
    "title": "Morning Tweet · 9:00am",
    "activity": [...]
  },
  "job": {
    "id": "uuid",
    "kind": "agent",
    "name": "Morning Tweet",
    "instructions": "Before doing anything else, set a short title ...\n\n---\n\nWrite an engaging tweet about...",
    "prerun": null,
    "postrun": null,
    "postrun_gates": false,
    "command": null,
    "workflow": null,
    "model": null,
    "thinking": null,
    "title_format": null,
    "timeout_minutes": 30
  },
  "agent": { "cli": "claude", "model": null, "thinking": null, "eager": false },
  "workspace": { "org": "acme", "project": "marketing", "agent": "social-media-bot" },
  "docs": [
    { "id": "uuid", "title": "Brand Voice", "content": "..." }
  ],
  "data": {
    "metrics": {
      "id": "uuid",
      "columns": [{ "name": "followers", "type": "INTEGER" }, { "name": "engagement_rate", "type": "REAL" }],
      "rows": [{ "_id": 1, "followers": 12400, "engagement_rate": 3.2 }]
    },
    "tweet_history": {
      "id": "uuid",
      "columns": [{ "name": "date", "type": "TEXT" }, { "name": "text", "type": "TEXT" }, { "name": "impressions", "type": "INTEGER" }],
      "rows": [{ "_id": 5, "date": "2024-03-01", "text": "...", "impressions": 340 }]
    }
  },
  "env": {
    "GITHUB_TOKEN": "ghp_...",
    "FIGMA_API_KEY": "figd_..."
  },
  "attachments": [
    {
      "id": "uuid", "run_id": "uuid", "activity_id": null, "kind": "file",
      "filename": "screenshot.png", "mime_type": "image/png", "size_bytes": 124000,
      "url": "https://your-harbour.example.com/api/runs/<run_id>/attachments/<id>/file",
      "embed_provider": null, "title": null,
      "uploaded_by_type": "user", "uploaded_by_name": "Gavin",
      "created_at": 1700000000
    },
    {
      "id": "uuid", "run_id": "uuid", "activity_id": null, "kind": "embed",
      "filename": null, "mime_type": null, "size_bytes": null,
      "url": "https://www.loom.com/share/...", "embed_provider": "loom",
      "title": "Walkthrough",
      "uploaded_by_type": "user", "uploaded_by_name": "Gavin",
      "created_at": 1700000000
    }
  ],
  "api": {
    "base_url": "https://your-harbour.example.com",
    "endpoints": {
      "set_title": "PUT https://your-harbour.example.com/api/runs/<run_id>/title",
      "update_status": "PUT https://your-harbour.example.com/api/runs/<run_id>/status",
      "post_activity": "POST https://your-harbour.example.com/api/runs/<run_id>/activity",
      "upload_attachment": "POST https://your-harbour.example.com/api/runs/<run_id>/attachments",
      "create_doc": "POST https://your-harbour.example.com/api/docs",
      "update_doc": "PUT https://your-harbour.example.com/api/docs/:id",
      "create_database": "POST https://your-harbour.example.com/api/databases",
      "insert_rows": "POST https://your-harbour.example.com/api/databases/:id/rows",
      "read_rows": "GET https://your-harbour.example.com/api/databases/:id/rows",
      "guide": "GET https://your-harbour.example.com/api/guide"
    },
    "status_options": ["done", "failed", "waiting"],
    "notes": [
      "Set a short run title via set_title before doing anything else — this is how humans identify the run on the dashboard.",
      "Set status to waiting if you need human input to continue (the run pauses until a human replies). The harness drives a dedicated finalize turn after your work, so you don't need to remember to set done/failed at the end.",
      "Post activity messages to log progress — these are visible on the dashboard.",
      "Attachments belong to the run thread — files (multipart) or video URL embeds (JSON {url}).",
      "Full API spec available at the guide endpoint."
    ]
  }
}
```

Everything the agent needs is bundled in one response: the run, job instructions (with optional per-job model/thinking overrides and any prerun/postrun gate commands — `prerun`, `postrun`, and `postrun_gates` are executed by the harbour-agent runner, not by you), the agent's own CLI config (`agent`, present on agent runs), the agent's workspace slugs (`workspace`, agent runs only — see below), referenced docs, databases (keyed by name; each carries its `id`, `columns`, and the most recent 100 `rows` — use the `id` with `insert_rows`/`read_rows` to write back), decrypted env vars, attachments (files + URL embeds), and the `api` section with pre-resolved endpoints for this run and available status options. Use the endpoints in `api` to update run status, post activity, upload attachments, and manage docs and databases — no need to construct URLs yourself.

The `workspace` field appears on agent runs only (workflow runs don't carry it) and holds three slugs locating the agent in the hierarchy — org, project, agent. Harbour runners derive the CLI's working directory from it as `workspaces/<org>/<project>/<agent>/` under the runner's Harbour home; external agents may ignore it or use it the same way. The slugs are identity segments, never absolute paths — they're assigned at creation and don't change when the org, project, or agent is renamed.

The `env` field contains decrypted environment variables linked to the job. Use these for API keys, tokens, and other credentials needed during the run.

The `attachments` field is the list of files and URL embeds attached to the run. Files have a download `url` that you can fetch with the same Bearer token. Embeds carry the source URL — recognised providers (`loom`, `youtube`, `vimeo`) render as inline players on the dashboard; anything else is recorded with `embed_provider: "generic"` and shown as a link.

### Peek (Read-Only Check)

```
GET /api/agents/:id/next?peek=true
```

Check if work is available without claiming anything. Useful for cron guards. Returns one of:

- `{"available": false, "reason": "busy"}` — agent already has a `running` run
- `{"available": false, "reason": "nothing_to_do"}` — no work
- `{"available": true, "type": "pending_resume", "run_id": "...", "job_name": "..."}` — a `pending` run is ready to resume
- `{"available": true, "type": "scheduled_run", "run_id": "...", "job_name": "..."}` — a triggered or requeued `scheduled` run is due
- `{"available": true, "type": "scheduled", "job_id": "...", "job_name": "..."}` — a recurring job is due (run will be created on the next non-peek call)

## Run Lifecycle

### Set Title

```
PUT /api/runs/:id/title
Content-Type: application/json

{ "title": "Issue #1234 — Fix login redirect" }
```

Each run carries a short human-readable title displayed on the dashboard. Harbour seeds a placeholder (the job name plus the time it fired); you should overwrite it **as the first action on every run** so the title reflects what you actually do.

The `/next` payload prepends a short instruction telling you to do this, and the `api.endpoints.set_title` field gives you the resolved URL. If the job sets a `title_format` (e.g. `"Issue #XXX — short summary"`), follow it; otherwise use a short sentence summarizing the run. Titles are trimmed and capped at 80 characters server-side.

### Update Status

```
PUT /api/runs/:id/status
Content-Type: application/json

{ "status": "waiting" }
```

Statuses you set (these are the `status_options` in the `/next` payload):
- `done` — completed successfully
- `failed` — something broke (or timed out)
- `waiting` — agent needs human input (surfaces on dashboard)

Statuses you'll see but shouldn't set yourself (the API accepts them, but they're managed by Harbour or the runner):
- `running` — set when a run is claimed via `/next`
- `pending` — set automatically when a human comments on a `waiting`/`done`/`failed`/`killed` run; queued for agent pickup
- `skipped` — a workflow or prerun gate determined there was nothing to do (exit code 77)
- `killed` — set by the harbour-agent runner when a kill request was honored

`scheduled` is a server-managed status (assigned when a run is created from the dashboard or via `POST /api/jobs/:id/trigger`) and cannot be set by an agent.

**Workflow runs are non-interactive.** Runs of workflow jobs (`kind: "workflow"`) accept only `running`, `done`, `failed`, `skipped`, and `killed` — submitting `waiting` or `pending` returns 400. They have no message thread: their activity log is runner output only, and user comments are rejected.

When a run transitions to `done`, `failed`, or `skipped`, Harbour automatically advances the job's `next_run_at` to the next scheduled time. No manual schedule management needed.

**Retrying:** Failed, skipped, and killed runs can be retried from the dashboard via `POST /api/runs/:id/retry`. An agent run goes back to `pending` with a system activity note, and the agent picks it up on next poll. A workflow run is requeued as `scheduled` so a workflow runner claims a fresh attempt.

**Timeouts:** Each job has a configurable `timeout_minutes` (default 30). It's a hard wallclock ceiling per running attempt, measured from when the run was claimed — not an inactivity window. A run that exceeds it is automatically failed on the next poll with a system message, even if it's still streaming output (a chatty run can still be wedged; the ceiling guarantees stuck runs never block the agent). Resuming a run (`pending` → `running`) starts a fresh attempt with a fresh clock.

### Add Activity

```
POST /api/runs/:id/activity
Content-Type: application/json

{ "content": "Found 3 new mentions. Processing...", "attachment_ids": ["uuid", ...] }
```

Activity entries support markdown. They form the visible record of what happened during the run. Returns the created entry with HTTP 201.

`attachment_ids` is optional. To attach files or embeds to a comment, upload them first via `POST /api/runs/:id/attachments`, then pass the returned ids in this field. Comments may have empty `content` if they only carry attachments — but a comment with neither `content` nor `attachment_ids` is rejected with 400.

### Attachments

Attach files (screenshots, PDFs, exports) or URL embeds (Loom, YouTube, Vimeo, or generic links) to a run. Both kinds appear in the activity thread on the dashboard and in the `attachments` array of `/next`.

**Upload a file (multipart/form-data):**

```
POST /api/runs/:id/attachments
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="file"; filename="screenshot.png"
Content-Type: image/png

<binary>
--boundary--
```

Multiple `file` parts in one request are supported. Per-file limit is set by `HARBOUR_MAX_UPLOAD_MB` (default 500MB); files larger than the cap fail with HTTP 413. Returns an array of attachment records.

**Attach an embed URL (JSON):**

```
POST /api/runs/:id/attachments
Content-Type: application/json

{ "url": "https://www.loom.com/share/abc123", "title": "Walkthrough" }
```

`title` is optional. The provider (`loom`, `youtube`, `vimeo`, `generic`) is detected from the URL — only well-formed URLs are accepted (returns 400 otherwise). Returns a single attachment record (201).

**List attachments:** `GET /api/runs/:id/attachments`
**Delete an attachment:** `DELETE /api/runs/:id/attachments/:aid`
**Download a file:** `GET /api/runs/:id/attachments/:aid/file` — same Bearer token works.

**The waiting flow:**

1. You need human input — set the run to `waiting` and add an activity message explaining what you need
2. The run surfaces on the dashboard. The human reads your message and responds
3. The status automatically changes from `waiting` to `pending` — the human's response is in the activity log
4. On your next `/next` poll, Harbour returns this `pending` run — status flipped to `running`, full activity history included
5. You read the human's response from the activity log and continue your work

Pending runs **always take priority** over scheduled jobs. Other jobs continue to fire normally while a run is waiting — work doesn't block.

## Databases

Databases are real SQLite tables managed through the API. Each database is a named table with typed columns — agents create them, insert rows, and link them to jobs. Linked databases are automatically injected into the `/next` payload.

### Create a Database

```
POST /api/databases
Content-Type: application/json

{
  "name": "tweet_history",
  "columns": [
    { "name": "date", "type": "TEXT", "required": true },
    { "name": "text", "type": "TEXT", "required": true },
    { "name": "likes", "type": "INTEGER" },
    { "name": "impressions", "type": "INTEGER" }
  ]
}
```

If a database with the same name already exists, it returns the existing one. Column types are native SQLite: `TEXT`, `INTEGER`, `REAL`. Every table gets an auto-incrementing `_id` column.

### Insert Rows

```
POST /api/databases/:id/rows
Content-Type: application/json

[
  { "date": "2024-03-01", "text": "Hot take: most API docs...", "likes": 156, "impressions": 5400 },
  { "date": "2024-03-02", "text": "Ship it Friday...", "likes": 89, "impressions": 3100 }
]
```

Body can be a single object or an array. Unknown columns are silently ignored.

### Read Rows

```
GET /api/databases/:id/rows?limit=50&offset=0&orderBy=date&order=DESC
```

Returns `{ rows: [...], total: 100, limit: 50, offset: 0 }`.

All query params are optional. Defaults: `limit=100`, `offset=0`, `order=DESC`, sorted by `rowid` descending when `orderBy` is omitted. `orderBy` must reference a real column or the request fails with 400.

### Update a Row

```
PUT /api/databases/:id/rows/:rowId
Content-Type: application/json

{ "likes": 200 }
```

### Delete a Row

```
DELETE /api/databases/:id/rows/:rowId
```

### Add a Column

```
POST /api/databases/:id/columns
Content-Type: application/json

{ "name": "retweets", "type": "INTEGER", "default": 0 }
```

Schema changes are tracked in a migration history.

### Link a Database to a Job

```
POST /api/jobs/:id/data
Content-Type: application/json

{ "databaseId": "uuid" }
```

Org-, project-, and job-linked databases are all included in the `/next` payload under `data`, keyed by name. Each entry is `{ id, columns, rows }` (most recent 100 rows per table) — use the `id` to target `insert_rows`/`read_rows` and `columns` for valid field names.

### Convenience Endpoint

Agents can also use the combined endpoint to create + link + seed in one call:

```
POST /api/agents/:id/data
Content-Type: application/json

{
  "name": "tweet_history",
  "columns": [{ "name": "date", "type": "TEXT" }, { "name": "text", "type": "TEXT" }],
  "jobId": "uuid",
  "rows": [{ "date": "2024-03-01", "text": "First tweet" }]
}
```

## Docs

Docs are org- or project-level resources linked to jobs. When a job fires, all its linked docs are included in the `/next` payload automatically. Pinned docs are auto-attached to new jobs created in their scope. Agents can also create and update docs:

### Create a Doc

```
POST /api/docs
Content-Type: application/json

{ "title": "Content Calendar", "content": "## March 2024\n..." }
```

### Update a Doc

```
PUT /api/docs/:id
Content-Type: application/json

{ "title": "New Title", "content": "Updated content..." }
```

Both fields are optional — send either or both. Doc revisions are preserved automatically.

## Reference Runner

```bash
#!/bin/bash
# Polls Harbour and invokes the LLM when there's work

RESPONSE=$(curl -s -H "Authorization: Bearer $KEY" \
  "$HARBOUR_URL/api/agents/$AGENT_ID/next")
[ -z "$RESPONSE" ] || [ "$RESPONSE" = "null" ] && exit 0

RUN_ID=$(echo "$RESPONSE" | jq -r '.run.id')

# Your LLM invocation here
# RESPONSE contains the full run context
```
