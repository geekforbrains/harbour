# Workflows

Workflows are deterministic scheduled shell commands. They are for work that should run the same way every time, on a schedule, without an agent and without an LLM.

Agent prerun commands are related, but they are not workflows. A prerun command belongs to an agent job and only exists to decide whether the agent should spend tokens on a run.

## The Boundary

| Feature | Own schedule | Own runner auth | Uses an agent | Uses an LLM | Purpose |
|---|---:|---:|---:|---:|---|
| Agent job | Yes | No | Yes | Yes | LLM-driven recurring work |
| Agent prerun command | No | No | Yes | No | Cheap gate before the LLM |
| Workflow | Yes | Yes | No | No | Deterministic recurring work |

Use a workflow when the command itself can finish the job: poll an API, reconcile a local file, sync a dataset, send a webhook, run a health check, or maintain a table.

Use an agent job with a prerun command when the command is only deciding whether there is enough work for an agent to think about.

## Data Model

Workflow jobs are stored in `jobs`:

| Column | Meaning |
|---|---|
| `kind = 'workflow'` | This job is a deterministic workflow |
| `agent_id = NULL` | No agent owns or runs it |
| `workflow_command` | Shell command executed by the workflow runner |
| `timeout_minutes` | Maximum runtime before stale runs are failed |

Agent jobs use the same table, but with a different shape:

| Column | Meaning |
|---|---|
| `kind = 'agent'` | This job is agent-backed |
| `agent_id` | Owning agent |
| `prerun_command` | Optional gate before the LLM |

Workflow runner credentials live in `workflow_runners`. They are org-scoped, enabled or disabled independently, and authenticate only workflow polling plus allowed workflow-run reporting endpoints.

## Creating Workflows

From the dashboard, create a new job and choose `Workflow`.

From the API:

```http
POST /api/jobs?projectId=<project-id>
Content-Type: application/json

{
  "name": "Health Check",
  "description": "Check API health every hour",
  "schedule": "{\"every\":60}",
  "command": "python3 check_health.py",
  "timeoutMinutes": 10
}
```

`POST /api/jobs` only creates workflows. Agent jobs are created under an agent with `POST /api/agents/:id/jobs`.

## Workflow Runners

Workflow runners are separate from agent runners. Agent runners do not claim workflow jobs.

Create runner credentials:

```http
POST /api/workflow-runners?orgId=<org-id>
Content-Type: application/json

{
  "name": "Ops Mac Mini",
  "labels": ["local", "ops"]
}
```

The response includes a connect command:

```bash
harbour workflow connect <blob>
```

On the runner host:

```bash
harbour workflow connect <blob>
harbour workflow run
harbour workflow install
```

The CLI stores workflow runner identity in:

```text
~/.harbour/workflow-runners.json
```

`harbour workflow install` creates a separate launchd service from `harbour agent install`, so deterministic workflows and agent jobs can be operated independently.

## Polling And Claiming

Workflow runners poll:

```http
GET /api/workflows/next
Authorization: Bearer <workflow-runner-api-key>
```

The endpoint returns `null` when there is no work, or a single run payload when a workflow is claimed.

Use `peek=true` to verify auth or check availability without claiming work:

```http
GET /api/workflows/next?peek=true
Authorization: Bearer <workflow-runner-api-key>
```

Agent API keys are rejected by `/api/workflows/next`. Workflow runner keys are denied by default on generic agent-or-user resource routes and opted in only where workflow-run reporting needs them.

## Execution Contract

The workflow runner executes the command with:

| Item | Value |
|---|---|
| Working directory | `$HARBOUR_HOME/workflows`, default `~/.harbour/workflows` |
| stdin | Full run payload JSON |
| stdout | Captured at process exit, posted as the final `workflow` activity entry |
| stderr | Captured at process exit |
| timeout | `job.timeout_minutes`, default 30 |
| env | `HARBOUR_RUN_ID`, `HARBOUR_API_KEY`, `HARBOUR_URL` (run credentials), plus every job-linked env var as `$NAME` |

Example script:

```python
#!/usr/bin/env python3
import json
import sys

payload = json.load(sys.stdin)
run_id = payload["run"]["id"]
api_token = payload["env"].get("EXTERNAL_API_TOKEN")

print(f"Checked external system for run {run_id}")
```

The command should be idempotent. A retry starts the command fresh, not from a CLI session.

## Live Progress Updates

Workflow runs have no message thread — but a long-running script can still post breadcrumbs to its **Output** log so a human can watch progress before it exits. The runner injects the run's credentials into the script's environment:

| Variable | Value |
|---|---|
| `HARBOUR_RUN_ID` | The current run's id |
| `HARBOUR_API_KEY` | The workflow runner's API key |
| `HARBOUR_URL` | Base URL of the Harbour server |

Post an update any time during the run:

```bash
curl -s -X POST "$HARBOUR_URL/api/runs/$HARBOUR_RUN_ID/activity" \
  -H "Authorization: Bearer $HARBOUR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Fetched 42 rows, syncing..."}'
```

Each call appends a `workflow`-authored entry to the run's Output, visible on the dashboard immediately. These are status breadcrumbs only — there is no reply, and posting more than once is expected. The script's stdout is still captured and posted as a final entry when the command exits, so simple scripts need none of this.

Note that stdout is *always* posted at exit. If you post breadcrumbs **and** also print the same lines to stdout, they appear twice in the Output. To avoid that, either post breadcrumbs and keep stdout quiet (or for skip/error detail only), or skip breadcrumbs and let the single stdout summary stand.

This is the same `POST /api/runs/:id/activity` endpoint agents use, but on a workflow run only the workflow runner key is accepted (user comments return 400). Keep updates terse and never echo secrets — Output is visible in the dashboard.

## Payload Shape

The workflow receives the same composed run context as an agent run, minus the agent runtime block and LLM API prompt.

```json
{
  "run": {
    "id": "uuid",
    "status": "running",
    "activity": []
  },
  "job": {
    "id": "uuid",
    "kind": "workflow",
    "name": "Health Check",
    "instructions": null,
    "prerun": null,
    "command": "python3 check_health.py",
    "workflow": "python3 check_health.py",
    "timeout_minutes": 30
  },
  "docs": [],
  "data": {},
  "env": {},
  "attachments": []
}
```

Linked docs, env vars, databases, and attachments are composed the same way as agent runs. Env vars are decrypted at request time and are plaintext inside the runner process, so treat workflow scripts as trusted code.

## Exit Codes

| Exit | Result |
|---:|---|
| `0` | Mark run `done`; trimmed stdout is posted as workflow activity |
| `77` | Mark run `skipped`; stderr is posted as activity if present |
| other | Mark run `failed`; stderr is preferred, then stdout |

Stdout is not streamed line-by-line; the trimmed buffer is posted once when the command exits or times out. For mid-run visibility on a long command, have the script post breadcrumbs itself — see [Live Progress Updates](#live-progress-updates).

## Status, Kill, And Retry

Workflow runs can be killed from the dashboard. The workflow runner polls the run kill endpoint while the command is running and terminates the child process when a kill is requested.

Terminal statuses:

| Status | Meaning |
|---|---|
| `done` | Command exited `0` |
| `skipped` | Command exited `77` |
| `failed` | Command exited non-zero, timed out, or runner hit an execution error |
| `killed` | User requested kill while the command was running |

These are the only statuses a workflow run moves through (plus `scheduled` and `running`). The human-loop statuses — `waiting` and `pending` — are agent-run concepts and are rejected with 400 on workflow runs.

Workflow runs also have no message thread. The activity log on a workflow run is captured runner output (stdout/stderr, recorded with author type `workflow`); user comments are rejected. If a workflow needs a human decision, that's a sign the work belongs in an agent job.

Retrying a workflow run requeues the same run as `scheduled` with an immediate `scheduled_for`, so the next workflow runner poll claims a fresh attempt of the command. There is no agent session to resume.

## Agent Prerun Commands

Agent jobs can define `prerun_command`. The agent runner executes it before invoking the LLM.

| Exit | Result |
|---:|---|
| `0` | Continue to the agent; stdout is appended as `## Prerun Output` |
| `77` | Mark run `skipped`; no LLM is invoked |
| other | Mark run `failed`; no LLM is invoked |

Prerun commands run from the same `$HARBOUR_HOME/workflows` directory and receive the same stdin payload shape, but they are not independently scheduled and do not use workflow-runner credentials.

## Script Layout

Recommended layout:

```text
~/.harbour/
  workflows/
    check_health.py
    sync_metrics.sh
    reconcile_orders.ts
```

Keep workflow scripts in version control if more than one machine runs them. Harbour stores the command string, not the script contents.

## Operational Notes

- Keep workflow commands deterministic and idempotent.
- Prefer exit `77` for "checked successfully, nothing to do".
- Use stdout for useful run summaries and stderr for skip/failure details.
- Do not put secrets in stdout or stderr. Activity is visible in the dashboard.
- Run `harbour workflow run` manually before installing the scheduler.
- Use `harbour workflow list` to see configured workflow runners on the host.
- Use separate runner hosts when workflows depend on machine-specific tools, local files, VPN access, Xcode, browser profiles, or hardware.
