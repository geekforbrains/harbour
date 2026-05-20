# Jobs and runs

A **job** is configuration: instructions, a trigger (when to fire), and links to docs/databases/env vars that a run will need. A **run** is a single execution of that job — a row with a status, an activity log, an optional CLI session, and a deadline.

Jobs don't *do* anything on their own. They sit in the database and wait. When an agent polls and the job is due, Harbour creates a run and hands the agent everything bundled. The job stays put; the run is what moves through the lifecycle.

## The mental model

| Layer | What it is | Lifetime |
|---|---|---|
| **Job** | Static config — schedule, instructions, linked context | Long-lived. Edited via the dashboard. |
| **Run** | Dynamic — one execution attempt | Minutes to hours, then terminal. |
| **Activity** | Append-only log of agent/user/system messages on a run | Lives with the run. |
| **Output events** | High-frequency stream of CLI deltas/tool calls (harbour agents only) | Lives in `run_output`. Drives the SSE feed. |

Jobs come in two flavors:

- **Agent jobs** — `agent_id` is set. The owning agent picks them up via `/api/agents/:id/next`.
- **Workflow-only jobs** — `agent_id IS NULL`, `workflow_only = 1`. No LLM. The local runner picks these up via `/api/workflows/next`. See [Workflows](workflows.md).

A third shape, **workflow + agent**, is an agent job whose `workflow_command` runs first as a gate. Same job row, just with both fields populated.

## Triggers

Jobs fire on a schedule. `next_run_at` is set when the job is created and advanced after every completion.

### Schedule format

`schedule` is JSON. Two shapes:

```json
{"every": 5}                                    // every 5 minutes
{"days": [1, 2, 3, 4, 5], "time": "09:00"}      // weekdays at 9am, system tz
```

`every` is minutes. `days` are 0=Sun..6=Sat. `time` is 24-hour `HH:MM` in the system timezone (set in **Settings**).

`normalizeSchedule` accepts a wider set of inputs and converts each to one of the two canonical shapes:

| Input | Normalized to |
|---|---|
| `every 5 minutes`, `every 2 hours`, `every 1 day`, `every 1 week` | `{"every": N}` |
| `hourly`, `hourly at :30` | `{"every": 60}` |
| `daily`, `daily at 9am`, `daily at 14:30` | `{"days": [0..6], "time": "HH:MM"}` |
| `weekly`, `weekly on friday at 9am` | `{"days": [d], "time": "HH:MM"}` |
| `*/5 * * * *` | `{"every": 5}` |
| `0 */N * * *` | `{"every": N*60}` |
| `M H * * 1-5` (and other DOW patterns) | `{"days": [...], "time": "HH:MM"}` |

Anything that doesn't match returns `null` and the API rejects it with 400. `POST /api/agents/:id/jobs` and `PUT /api/jobs/:id` write the normalized JSON; `POST /api/jobs` (workflow-only) only validates via `isValidSchedule`, so a non-JSON string can still land in the column there. A startup migration normalizes any non-JSON `schedule` rows on schema init.

Intervals are timezone-agnostic: every 5 minutes is every 5 minutes wall-clock. Weekly schedules use the system timezone for the day-of-week and time matching, and `getNextRunTime` walks forward up to 7 days, then wraps.

## One-off and triggered runs

Most runs come from a recurring job firing on schedule. Two other paths exist:

**One-off runs** — created from the dashboard's New Run dialog. `createOneOffRun` writes a hidden `one_off=1` job (so it's hidden from the Jobs page) and a `scheduled` run pointing at it. When the run reaches a terminal state, the backing job gets `active=0` and `next_run_at=NULL`, so it's truly one-shot.

**Triggered runs** — `POST /api/jobs/:id/trigger` with optional `{"instructions": "..."}`. Inserts a fresh `scheduled` run for an existing recurring job, with `extra_instructions` saved on the run. The runner appends those to `job.instructions` in the prompt and adds a "Additional instructions: ..." system activity entry. The recurring schedule keeps ticking — a triggered run is one extra firing on top of the regular cadence.

## The polling ladder

`getAgentNextRun(agentId)` is the single source of truth for agent work assignment. It runs `failStaleRuns` first, then four assignment checks wrapped in a transaction:

```
0. Fail any running run that's exceeded its job's timeout (failStaleRuns)
1. Already a 'running' run for this agent? → return null (busy, wait your turn)
2. A 'pending' run? (human responded) → flip to 'running', return it
3. A 'scheduled' run with scheduled_for <= now? (one-off / triggered) → claim it
4. A schedule-trigger job past next_run_at with no active run? → create a run, advance next_run_at
5. Nothing → null
```

Order matters. Pending always wins so a human reply doesn't get stuck behind tomorrow's recurring run. One-off scheduled runs beat recurring schedules so dashboard-created work isn't elbowed out by a chatty cron job.

Step 0 is important: if a previous `running` run is wedged past its job's `timeout_minutes`, step 1 would otherwise gate this agent forever. `failStaleRuns` checks `updated_at + (timeout_minutes * 60) < now()` and force-fails any matches with a system activity entry: "Run timed out after N minutes without completion."

`peek=true` runs the same checks read-only — useful as a guard before invoking your CLI tool.

There's a parallel ladder for agentless workflow runs (`getNextWorkflowRun`) — same shape, but filtered to `agent_id IS NULL AND workflow_only = 1`. See [Workflows](workflows.md).

## The run lifecycle

```
scheduled ──► running ──► done
                       ──► failed
                       ──► skipped     (workflow exit 77)
                       ──► killed      (harbour-agent only)
                       ──► waiting ──► pending ──► running ──► …
```

The `runs.status` column has a CHECK constraint enforcing one of those eight values:

```sql
CHECK(status IN ('scheduled','running','waiting','pending','done','failed','skipped','killed'))
```

| Status | Meaning |
|---|---|
| `scheduled` | One-off or triggered, waiting for `scheduled_for <= now`. Recurring schedule-trigger jobs skip this and go straight to `running` on creation. |
| `running` | Agent is working. Activity is updating. Counts toward the "agent busy" check. |
| `waiting` | Agent paused for human input. Surfaces on the dashboard. Doesn't block other jobs from firing. |
| `pending` | Human responded — flipped automatically when a user posts activity to a `waiting` run. Next poll claims it. |
| `done` | Completed successfully. |
| `failed` | Agent or workflow returned non-zero, or the run timed out. |
| `skipped` | Workflow returned exit 77 — "nothing to do." |
| `killed` | A user clicked Kill on a harbour-agent run. Resumable via comment. |

When a run reaches `done`, `failed`, or `skipped`, `updateRunStatus` advances the job's `next_run_at` (or deactivates the job if it's `one_off`). `killed` is **terminal for the run but does not advance the job's schedule** — the user stopped it intentionally and may resume.

### Timeouts

`jobs.timeout_minutes` defaults to 30. The runner enforces it as the CLI subprocess timeout. Harbour itself enforces it via `failStaleRuns`: if `updated_at + timeout_minutes*60 < now`, the run is marked `failed` on the next poll. `updated_at` ticks every time activity, output events, or status updates happen — so a chatty run that keeps streaming isn't considered stale even if the CLI subprocess has been alive for hours.

### Retry

```
POST /api/runs/:id/retry
```

Allowed for `failed`, `skipped`, and `killed` runs. Flips the status to `pending` and adds a system activity entry. The agent's next poll picks it up at step 2 of the ladder above. Retry doesn't reset the activity log — the agent sees the prior attempts in `/next`'s `run.activity` and can act on them.

### Kill (harbour agents only)

```
POST /api/runs/:id/kill
```

Only allowed for runs whose agent has `type = 'harbour'` and whose status is `running`. Sets `runs.kill_requested_at`. The runner notices via two channels:

1. **Piggyback** — every `POST /api/runs/:id/output` flush returns `{kill_requested: bool}`. While the CLI streams, this is hot-path latency (~750ms).
2. **Fallback poll** — `GET /api/runs/:id/kill` every 10s. Catches stretches where the CLI is silent (long thinking, model-side stalls).

Either fires an `AbortController` that SIGTERMs the CLI, waits 3s, then SIGKILLs. The runner saves the CLI session ID, posts a "Run killed by user. Comment on this run to resume…" activity message, and sets status `killed`. A user comment flips it back through `pending → running` and resumes the CLI session.

External-agent runs return 400 from this endpoint — Harbour has no process to signal.

## What the agent gets

`/next` returns one bundle: the run, the job, referenced docs, database rows (most-recent 100 per linked table), decrypted env vars, attachments, and an `api` section with pre-resolved endpoints and the allowed status options. See [GUIDE.md](../../GUIDE.md) for the wire-level shape — that's what an agent reads at `/api/guide`.

A few invariants worth knowing:

- `job.instructions` already has any `extra_instructions` from a triggered run appended underneath a `---` separator (`buildRunPayload`).
- `env` is decrypted at payload-build time. The dashboard can't see plaintext after creation, but the agent does on each poll.
- `attachments` is the full list (files + URL embeds). Files have a download URL the agent can fetch with the same Bearer token.

## Source-of-truth pointers

- `src/lib/db/jobs.ts` — `createJob`, `updateJob`, `createOneOffRun`, `triggerJobRun`, `advanceJobSchedule`.
- `src/lib/db/runs.ts` — the polling ladder (`getAgentNextRun`, `getNextWorkflowRun`), `failStaleRuns`, `updateRunStatus`, `requestKillRun`, `buildRunPayload`.
- `src/lib/schedule.ts` — `normalizeSchedule` (the human-readable / cron parser) and `getNextRunTime` (timezone-aware advancer).
- `src/lib/db/schema.ts` — the `runs` CHECK constraint and the `jobs` columns that drive triggers.
- `src/app/api/runs/[id]/status/route.ts` — status transitions.
- `src/app/api/runs/[id]/kill/route.ts` and `src/app/api/runs/[id]/retry/route.ts` — terminal-state operations.
- `GUIDE.md` — the wire contract an agent reads at `/api/guide`.
