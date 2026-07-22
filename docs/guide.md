# Harbour Agent Guide

This document covers everything an agent needs to work with Harbour. It is served at `GET /api/guide`.

## Overview

Harbour is a control plane that manages your recurring jobs, shared docs, tables, and encrypted environment variables. It doesn't control how you do your work — it tells you *what* to do, *when*, and gives you the context to do it.

You don't poll Harbour yourself — a **runner** claims work on your behalf and spawns you (the CLI) with the run already in hand: instructions, referenced docs, table rows, env vars, and a pre-resolved `api` block. You do the work, log your activity, and mark it done — or set it to "waiting" if you need human input. Humans respond on the dashboard, and a later claim picks the run back up. You can also create and update shared docs and manage structured data through the API.

The runner↔server side of this — how a runner claims a run, what it advertises, the shape of the run payload — is a separate contract served at `GET /api/runner-guide` (the Runner Protocol). This document is the worker-agent contract: what you receive once spawned, and how you call back.

Key concepts:
- **Jobs** — recurring responsibilities with a schedule, instructions, and linked docs/tables/env vars
- **Runs** — a single execution of a job, with an activity log of agent and human messages
- **Docs** — shared markdown documents, injected into runs automatically
- **Tables** — SQLite tables you create and manage, injected into runs automatically
- **Env Vars** — encrypted key-value pairs (API keys, tokens), decrypted and injected at runtime

## Scheduling

Jobs use the `schedule` field to define when they run. Harbour automatically computes `next_run_at` when a job is created, and advances it each time a run reaches a terminal status (`done`, `failed`, `skipped`, or `killed`). You don't need to manage `next_run_at` yourself.

All schedule times use the instance timezone, set in Settings (it falls back to the server's own timezone when unset).

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

Every callback you make for a run is authenticated with that run's **exec token** — a per-run credential (`hbx_…`) minted when the runner claimed the run and handed to you in the `api` block. Send it as a Bearer token:

```
Authorization: Bearer hbx_<exec_token>
```

The exec token is scoped to a single run and rotated on every re-claim, so it carries the lifecycle endpoints (`set_title`, `update_status`, `post_activity`, `upload_attachment`, …) as well as the docs and tables endpoints. You never see or use the runner's own token, and an agent has no long-lived API key of its own — run work is authenticated entirely by this exec token. Read the resolved URLs and the auth note straight out of `api` (see the next section); don't construct them yourself.

## Your Run Context

Harbour never calls out to agents and you never poll it. A runner claims the next runnable unit from the server — the Runner Protocol, served at `GET /api/runner-guide` — and spawns you with the full run context already resolved. The server decides what to hand over — most notably:

- A `pending` run a human nudged back into the queue is resumed (full activity history included) ahead of fresh scheduled work.
- A `scheduled` run (triggered from the dashboard or via `POST /api/jobs/:id/trigger`) is claimed when due.
- A recurring job past its scheduled time is materialized into a new run.

You don't see that selection — you just receive the chosen run, already flipped to `running`, as the context below.

**Run context (what the runner hands you):**
```json
{
  "run": {
    "id": "uuid",
    "status": "running",
    "title": "Morning Tweet · 9:00am",
    "activity": [...]
  },
  "exec_token": "hbx_...",
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
    "timeout_minutes": 30,
    "scripts_dir": "marketing/social-media-bot/morning-tweet-1a2b3c4d"
  },
  "agent": { "cli": "claude", "model": null, "thinking": null, "eager": false },
  "workspace": { "project": "marketing", "agent": "social-media-bot" },
  "docs": [
    { "id": "uuid", "title": "Brand Voice", "content": "..." }
  ],
  "tables": {
    "metrics": { "id": "uuid" },
    "tweet_history": { "id": "uuid" }
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
    "auth": "Bearer <exec_token> (from this claim) on every endpoint below — the /api/runs/:id/* lifecycle calls and the docs/tables endpoints",
    "endpoints": {
      "set_title": "PUT https://your-harbour.example.com/api/runs/<run_id>/title",
      "update_status": "PUT https://your-harbour.example.com/api/runs/<run_id>/status",
      "post_activity": "POST https://your-harbour.example.com/api/runs/<run_id>/activity",
      "post_output": "POST https://your-harbour.example.com/api/runs/<run_id>/output",
      "poll_kill": "GET https://your-harbour.example.com/api/runs/<run_id>/kill",
      "save_session": "PUT https://your-harbour.example.com/api/runs/<run_id>/session",
      "upload_attachment": "POST https://your-harbour.example.com/api/runs/<run_id>/attachments",
      "create_doc": "POST https://your-harbour.example.com/api/docs",
      "update_doc": "PUT https://your-harbour.example.com/api/docs/:id",
      "create_table": "POST https://your-harbour.example.com/api/tables",
      "insert_rows": "POST https://your-harbour.example.com/api/tables/:id/rows",
      "read_rows": "GET https://your-harbour.example.com/api/tables/:id/rows",
      "guide": "GET https://your-harbour.example.com/api/guide"
    },
    "status_options": ["done", "failed", "waiting"],
    "notes": [
      "Set a short run title via set_title before doing anything else — this is how humans identify the run on the dashboard.",
      "Set status to waiting if you need human input to continue (the run pauses until a human replies). The harness drives a dedicated finalize turn after your work, so you don't need to remember to set done/failed at the end.",
      "Post activity messages to log progress — these are visible on the dashboard.",
      "Attachments belong to the run thread — files (multipart) or URL embeds (JSON {url}).",
      "Full API spec available at the guide endpoint."
    ]
  }
}
```

Everything the agent needs is bundled in the context the runner passes through: the run, the `exec_token` you authenticate callbacks with, job instructions (with optional per-job model/thinking overrides and any prerun/postrun gates — `prerun`, `postrun`, and `postrun_gates` are executed by the runner, not by you), the agent's own CLI config (`agent`, present on agent runs), the agent's workspace slugs (`workspace`, agent runs only — see below), injected docs, injected tables (keyed by name; each carries only its `id` — read rows with `read_rows` and write with `insert_rows`, both targeted by `id`; no rows or columns are inlined), env vars, attachments (files + URL embeds), and the `api` section with pre-resolved endpoints for this run and available status options. A run's docs, tables, and env vars come from two sources: resources **pinned** in the job's own project (injected automatically) and resources **explicitly linked to the job** (from any project) — a linked resource wins on a collision. Use the endpoints in `api` to update run status, post activity, upload attachments, and manage docs and tables — no need to construct URLs yourself, and send the `exec_token` (echoed in `api.auth`) as the Bearer on each one.

The `workspace` field appears on agent runs only (workflow runs don't carry it) and holds two slugs locating the agent in the hierarchy — project, agent. Harbour runners derive the CLI's working directory from it as `workspaces/<project>/<agent>/` under the runner's Harbour home; external agents may ignore it or use it the same way. The slugs are identity segments, never absolute paths — they're assigned at creation and don't change when the project or agent is renamed.

The `job.prerun`, `job.postrun`, `job.command`, `job.workflow`, and `job.scripts_dir` fields carry the job's gates for the runner that executes them. They are present on every run (agent and workflow):

- Each gate is a `{ runtime, content }` object (or `null` when unset). `runtime` is one of `bash`, `python`, or `node`; `content` is the script body, stored verbatim. `prerun` and `postrun` are the agent-job gates; `command` and `workflow` are two aliases for the same workflow gate (both set on workflow runs, both `null` on agent runs).
- `scripts_dir` is a **relative** path under the runner's `$HARBOUR_HOME/workflows` root — `<project>/<agent>/<job-leaf>` for agent jobs, `<project>/<job-leaf>` for workflows. The runner `mkdir -p`s this per-job directory, materializes each present gate's `content` into it as `<role>.<ext>` (`prerun`/`postrun`/`workflow`; `bash`→`.sh`, `python`→`.py`, `node`→`.js`) with an executable mode, and runs it from there via the runtime's interpreter (`bash <file>` / `python3 <file>` / `node <file>`).

These fields matter only to a runner that executes the gates; if you're a worker doing the actual LLM work (not running `prerun`/`postrun`/`command`), you can ignore them.

The `env` field contains decrypted environment variables linked to the job. Use these for API keys, tokens, and other credentials needed during the run.

The `attachments` field is the list of files and URL embeds attached to the run. Files have a download `url` that you can fetch with the run's exec token as the Bearer. Embeds carry the source URL — recognised providers (`loom`, `youtube`, `vimeo`) render as inline players on the dashboard; anything else is recorded with `embed_provider: "generic"` and shown as a link.

> Claiming and read-only availability checks (`?peek=true`) are the runner's job, not yours — they belong to the runner↔server protocol, the Runner Protocol served at `GET /api/runner-guide`.

## Run Lifecycle

### Set Title

```
PUT /api/runs/:id/title
Content-Type: application/json

{ "title": "Issue #1234 — Fix login redirect" }
```

Each run carries a short human-readable title displayed on the dashboard. Harbour seeds a placeholder (the job name plus the time it fired); you should overwrite it **as the first action on every run** so the title reflects what you actually do.

The run context prepends a short instruction telling you to do this, and the `api.endpoints.set_title` field gives you the resolved URL. If the job sets a `title_format` (e.g. `"Issue #XXX — short summary"`), follow it; otherwise use a short sentence summarizing the run. Titles are trimmed and capped at 80 characters server-side.

### Update Status

```
PUT /api/runs/:id/status
Content-Type: application/json

{ "status": "waiting" }
```

Statuses you set (these are the `status_options` in the `api` block):
- `done` — completed successfully
- `failed` — something broke (or timed out)
- `waiting` — agent needs human input (surfaces on dashboard)

Statuses you'll see but shouldn't set yourself (they're managed by Harbour or the runner):
- `running` — set when a runner claims the run
- `pending` — set automatically when a human comments on a `waiting`/`done`/`failed`/`killed` run; queued for agent pickup. An exec token asking for `pending` is rejected with 403
- `skipped` — a workflow or prerun gate determined there was nothing to do (exit code 77)
- `killed` — set by the harbour-agent runner when a kill request was honored

`scheduled` is a server-managed status (assigned when a run is created from the dashboard or via `POST /api/jobs/:id/trigger`) and cannot be set by an agent.

**Workflow runs are non-interactive.** Runs of workflow jobs (`kind: "workflow"`) accept only `running`, `done`, `failed`, `skipped`, and `killed` — submitting `waiting` or `pending` returns 400. They have no message thread: their activity log is runner output only, and user comments are rejected.

When a run transitions to a terminal status (`done`, `failed`, `skipped`, or `killed`), Harbour automatically advances the job's `next_run_at` to the next scheduled time. No manual schedule management needed.

**Retrying:** Failed, skipped, and killed runs can be retried from the dashboard via `POST /api/runs/:id/retry`. An agent run goes back to `pending` with a system activity note, and is resumed the next time a runner claims it. A workflow run is requeued as `scheduled` so a runner advertising the `workflow` kind claims a fresh attempt.

**Timeouts:** Each job has a configurable `timeout_minutes` (default 30). It's a hard wallclock ceiling per running attempt, measured from when the run was claimed — not an inactivity window. A run that exceeds it is automatically failed on the next claim with a system message, even if it's still streaming output (a chatty run can still be wedged; the ceiling guarantees stuck runs never block the agent). Resuming a run (`pending` → `running`) starts a fresh attempt with a fresh clock.

### Add Activity

```
POST /api/runs/:id/activity
Content-Type: application/json

{ "content": "Found 3 new mentions. Processing...", "attachment_ids": ["uuid", ...] }
```

Activity entries support markdown. They form the visible record of what happened during the run. Returns the created entry with HTTP 201.

`attachment_ids` is optional. To attach files or embeds to a comment, upload them first via `POST /api/runs/:id/attachments`, then pass the returned ids in this field. Comments may have empty `content` if they only carry attachments — but a comment with neither `content` nor `attachment_ids` is rejected with 400.

### Attachments

Attach files (screenshots, PDFs, exports) or URL embeds (Loom, YouTube, Vimeo, or generic links) to a run. Both kinds appear in the activity thread on the dashboard and in the `attachments` array of the run context.

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
**Download a file:** `GET /api/runs/:id/attachments/:aid/file` — the run's exec token works as the Bearer.

**The waiting flow:**

1. You need human input — set the run to `waiting` and add an activity message explaining what you need
2. The run surfaces on the dashboard. The human reads your message and responds
3. The status automatically changes from `waiting` to `pending` — the human's response is in the activity log
4. A runner re-claims this `pending` run on a later poll and re-spawns you — status flipped to `running`, full activity history included, with a freshly minted exec token in the `api` block
5. You read the human's response from the activity log and continue your work

Pending runs **always take priority** over scheduled jobs. Other jobs continue to fire normally while a run is waiting — work doesn't block.

## Tables

Tables are real SQLite tables managed through the API. Each table is a named table with typed columns — agents create them, insert rows, and link them to jobs. A table injected into a run is a **read reference**: the run context carries only its `name` and `id`, never its rows or columns. Read its contents on demand with `read_rows` and write with `insert_rows`, both targeted by `id`. A table pinned in a job's project is injected into that job's runs automatically (like pinned docs and secrets).

### Create a Table

```
POST /api/tables
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

If a table with the same name already exists, it returns the existing one. Column types are native SQLite: `TEXT`, `INTEGER`, `REAL`. Every table gets an auto-incrementing `_id` column.

### Insert Rows

```
POST /api/tables/:id/rows
Content-Type: application/json

[
  { "date": "2024-03-01", "text": "Hot take: most API docs...", "likes": 156, "impressions": 5400 },
  { "date": "2024-03-02", "text": "Ship it Friday...", "likes": 89, "impressions": 3100 }
]
```

Body can be a single object or an array. Unknown columns are silently ignored.

### Read Rows

```
GET /api/tables/:id/rows?limit=50&offset=0&orderBy=date&order=DESC
```

Returns `{ rows: [...], total: 100, limit: 50, offset: 0 }`.

All query params are optional. Defaults: `limit=100`, `offset=0`, `order=DESC`, sorted by `rowid` descending when `orderBy` is omitted. `orderBy` must reference a real column or the request fails with 400.

### Update a Row

```
PUT /api/tables/:id/rows/:rowId
Content-Type: application/json

{ "likes": 200 }
```

### Delete a Row

```
DELETE /api/tables/:id/rows/:rowId
```

### Add a Column

```
POST /api/tables/:id/columns
Content-Type: application/json

{ "name": "retweets", "type": "INTEGER", "default": 0 }
```

A column added here can be `required` (NOT NULL) only if you also supply a
`default` — SQLite adds the column to existing rows, so a NOT NULL column with no
default is rejected with a 400. (At table-creation time a `required` column needs
no default, since the table starts empty.) Schema changes are tracked in a
migration history.

### Link a Table to a Job

```
POST /api/jobs/:id/tables
Content-Type: application/json

{ "tableId": "uuid" }
```

A run's `tables` (keyed by name) are the tables **pinned in the job's project** plus those **linked to the job** via this endpoint — a table in the same project as the job is not injected unless it's pinned or linked. Each entry is `{ id }` only; no columns or rows are inlined. Use the `id` to read rows with `read_rows` and write with `insert_rows`; `GET /api/tables/:id` returns the table's column schema if you need it.

### Convenience Endpoint

Agents can also use the combined endpoint to create + link + seed in one call:

```
POST /api/agents/:id/tables
Content-Type: application/json

{
  "name": "tweet_history",
  "columns": [{ "name": "date", "type": "TEXT" }, { "name": "text", "type": "TEXT" }],
  "jobId": "uuid",
  "rows": [{ "date": "2024-03-01", "text": "First tweet" }]
}
```

## Docs

Docs are project-level resources. When a job fires, the run context includes the docs pinned in the job's project plus the docs explicitly linked to the job. Agents can also create and update docs:

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

## Worker callbacks

You don't claim work — a runner does that (the Runner Protocol, served at `GET /api/runner-guide`) and spawns you with the run context already in hand. From there you read the exec token and the resolved endpoints out of the context and call back against this run:

```bash
#!/bin/bash
# $CONTEXT is the run context the runner handed you (the JSON above).

RUN_ID=$(echo "$CONTEXT" | jq -r '.run.id')
EXEC_TOKEN=$(echo "$CONTEXT" | jq -r '.exec_token')
SET_TITLE=$(echo "$CONTEXT" | jq -r '.api.endpoints.set_title')

# Authenticate every callback with the run's exec token — never a runner or agent key.
curl -s -X PUT "$SET_TITLE" \
  -H "Authorization: Bearer $EXEC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Issue #1234 — Fix login redirect"}'

# Do the work, posting activity and (finally) a terminal status the same way,
# each against the endpoints in $CONTEXT.api.endpoints with $EXEC_TOKEN.
```
