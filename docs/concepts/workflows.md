# Workflows

A workflow is a shell command stored on a job. The local runner executes it on the runner's host before (or instead of) handing off to a CLI agent. It's how Harbour does deterministic, code-defined work without involving an LLM.

The whole feature is two columns on `jobs`:

| Column | Meaning |
|---|---|
| `workflow_command` | The shell command to run. `NULL` means no workflow. |
| `workflow_only` | `1` = the command **is** the job; no agent invocation. `0` = the command is a gate that runs before the agent. |

Combined with the agent attachment, that gives three modes.

## The three modes

| Mode | `agent_id` | `workflow_command` | `workflow_only` | What runs |
|---|---|---|---|---|
| **Agent only** | set | `NULL` | `0` | Agent only. Normal poll → CLI invocation. |
| **Workflow + agent** | set | set | `0` | Workflow runs first as a gate. On exit 0, the agent fires with the workflow's stdout appended to the prompt. On exit 77, the run is `skipped`. Anything else, `failed`. |
| **Workflow only** | `NULL` | set | `1` | Workflow runs alone. Stdout becomes a single activity entry. No LLM ever touches the run. |

The first two are agent jobs and are picked up via `GET /api/agents/:id/next`. The third is agentless and is picked up via `GET /api/workflows/next` by whichever runner is co-located with the harbour server. (Remote runners skip that poll — see [Agents](agents.md).)

## The exit code protocol

The runner branches on the workflow's exit code in exactly three buckets:

```
exit 0   → success
  ├─ workflow-only:  status = "done", stdout becomes activity
  └─ workflow+agent: stdout becomes prompt context for the agent

exit 77  → skip (no work to do)
  status = "skipped", stderr (if any) becomes activity

other    → failed
  status = "failed", stderr or stdout becomes activity
```

Exit 77 is the only "soft skip" — it's how a watcher script says "I checked, there's nothing for the agent to do, advance the schedule and move on." Without it, every poll where there's no work would post a `done` run and clutter the activity feed.

## The stdin contract

The runner pipes the full `/next` payload to the workflow process's stdin as a single JSON document, then closes stdin. It's the same JSON the runner just received from Harbour — the shape produced by `buildRunPayload`. So a workflow has access to:

- `run.id`, `run.status`, `run.activity`
- `job.name`, `job.instructions`, `job.workflow`, `job.workflow_only`, `job.timeout_minutes`
- `docs[]` — linked markdown docs, full content
- `data` — most-recent 100 rows per linked database, keyed by table name
- `env` — decrypted env vars, keyed by name
- `attachments[]` — files and embeds (gated mode also has serialized download URLs)

In **workflow + agent** mode the runner gets the payload from `/api/agents/:id/next`, which additionally includes the `api.endpoints` cheat-sheet (status/activity/upload URLs). In **workflow only** mode the runner gets it from `/api/workflows/next`, which omits that block — agentless workflows already know they're running locally and can hard-code or read API URLs from `env`.

Read it with whatever you like. A typical Python workflow:

```python
import json, sys
payload = json.load(sys.stdin)
run_id  = payload["run"]["id"]
api_key = payload["env"]["MY_API_KEY"]
```

## The stdout contract

What you print to stdout depends on the mode:

- **Workflow only.** Stdout is captured (trimmed) and posted as a single activity entry on the run. If you want richer formatting, post your own `POST /api/runs/<id>/activity` calls during execution; just remember the run-status update at the end is automated.
- **Workflow + agent.** Stdout is captured and appended to the agent's prompt under a `## Workflow Output` heading. So a script can fetch context (an RSS feed, a PR diff, a database query) and let the agent reason over it. The agent does not see stderr; that's runner-internal.
- **Skip (exit 77).** If stderr is non-empty, it's posted as activity. Stdout is ignored — exit 77 means "nothing to log here."
- **Failure (any other non-zero).** Stderr is preferred for the activity entry; if empty, stdout is used; if both are empty, `Workflow exited with code N` is posted.

There's no streaming. Stdout is captured at end-of-process, all at once. If your workflow takes 12 minutes, the dashboard sees nothing until it's done — then the entire blob lands.

## Where workflow scripts live

The runner sets the workflow process's `cwd` to:

```
$HARBOUR_HOME/workflows    # default: ~/.harbour/workflows
```

That directory is auto-created on first use. It's shared across **all** workflows on this runner — every job's command runs from the same dir. Put your scripts there (or a git checkout of them), reference them by relative path in your `workflow_command`:

```bash
python3 check_health.py
./scrape_pr.sh
node fetch_metrics.js
```

Two consequences:

- Workflow scripts on the runner host are not on the harbour server. For remote runners, `~/.harbour/workflows/` lives on the *remote* machine. Sync it as you would any other dotfile.
- Two jobs running concurrently share the workflow cwd. If your scripts write temp files, namespace them per run (`mktemp -d` or use the run ID from stdin).

## Timeouts

The runner uses two different timeouts:

| Mode | Timeout | Why |
|---|---|---|
| Workflow + agent (gate) | **30 seconds**, hard-coded | Gates are checks. They should be cheap. If your gate takes a minute, lift the work into a workflow-only job or move it inside the agent. |
| Workflow only | `job.timeout_minutes * 60` (default 30 min) | The workflow is the whole job; treat it like any other run. |

Hitting the timeout sends SIGTERM, then captures whatever's been printed so far, then resolves as a non-zero exit — which means the run lands as `failed` (or `killed` if a kill was already in flight).

## Kill

Both the gate and workflow-only paths poll `GET /api/runs/:id/kill` every 10s during execution and abort on a kill request. The workflow process gets a single SIGTERM (no SIGKILL grace — that lives in the CLI runner path) and the run is finalized as `killed`. Workflows have no session and no resume — there's nothing to save — so a killed workflow run that's retried starts fresh.

## A worked example: workflow-only health check

A standalone script that runs every 5 minutes, pings an API, and skips quietly if all is well:

```python
#!/usr/bin/env python3
# ~/.harbour/workflows/check_api.py
import json, os, sys, urllib.request

payload = json.load(sys.stdin)
api_key = payload["env"]["HARBOUR_API_KEY"]
run_id  = payload["run"]["id"]
target  = payload["env"]["API_URL"]

try:
    code = urllib.request.urlopen(target, timeout=10).status
except Exception as e:
    print(f"Health check failed: {e}", file=sys.stderr)
    sys.exit(1)  # → run failed

if code == 200:
    sys.exit(77)  # → run skipped (the common case, no noise)

# Anything other than 200 — log it and let it land as `done`
print(f"Got HTTP {code} from {target}")
sys.exit(0)
```

Job config: `workflow_command = "python3 check_api.py"`, `workflow_only = true`, `schedule = {"every": 5}`.

## A worked example: gated PR review

A workflow checks for open PRs needing review; if there are any, the agent runs over the workflow's output to draft comments.

```bash
#!/bin/bash
# ~/.harbour/workflows/list_pending_prs.sh
set -e
PRS=$(gh pr list --search "review-requested:@me" --state open --json number,title,url)
COUNT=$(echo "$PRS" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  echo "No PRs awaiting review." >&2
  exit 77   # → skipped, agent does not run
fi
echo "$PRS"  # stdout becomes ## Workflow Output in the agent prompt
```

Job config: `workflow_command = "bash list_pending_prs.sh"`, `workflow_only = false`, `instructions = "Review each PR below. Post a summary on each."`. The agent only ever fires when there's actual work, and it gets the PR list as structured input it can reason over.

## What workflows can't do

- **No streaming.** Stdout/stderr are captured at end-of-process. The dashboard sees one blob at completion.
- **No session, no resume.** Workflows are stateless. A `killed` workflow run is just gone; retrying it starts from scratch.
- **No partial activity from inside the workflow.** You can `curl` `POST /api/runs/<id>/activity` mid-run if you want to log progress — that's how an external agent would do it — but the runner won't do it for you.
- **No model/thinking knobs.** Workflows are deterministic shell. Any LLM control belongs on the agent half of a workflow+agent job.

## Source-of-truth pointers

- `bin/lib/runner.mjs` — `runWorkflow`, the gate-vs-only branching in `runSingleAgent`, and the agentless `runAgentlessWorkflows` poll. Also the 30s gate timeout, exit-77 handling, and the `isLocalUrl` filter that skips remote runners.
- `src/lib/db/runs.ts` — `getNextWorkflowRun` (the agentless polling ladder) and `buildRunPayload` (the JSON shape piped to stdin).
- `src/lib/db/jobs.ts` — `createJob` and the `workflowOnly` / `workflowCommand` fields it accepts.
- `src/app/api/workflows/next/route.ts` — the agentless workflow poll endpoint.
- `src/app/api/jobs/route.ts` — `POST /api/jobs` for creating agentless workflow-only jobs (no `agentId`).
- `src/lib/db/schema.ts` — the `workflow_command` and `workflow_only` columns on `jobs`, and the migration that made `agent_id` nullable.
