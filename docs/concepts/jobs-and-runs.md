# Jobs and runs

A **job** is configuration: instructions, a trigger (when to fire), and links to docs/tables/env vars that a run will need. A **run** is a single execution of that job — a row with a status, an activity log, an optional CLI session, and a deadline.

Jobs don't *do* anything on their own. They sit in the database and wait. When the job is due and a runner claims it, Harbour creates a run and hands the runner everything bundled. The job stays put; the run is what moves through the lifecycle.

## The mental model

| Layer | What it is | Lifetime |
|---|---|---|
| **Job** | Static config — schedule, instructions, linked context | Long-lived. Edited via the dashboard. |
| **Run** | Dynamic — one execution attempt | Minutes to hours, then terminal. |
| **Activity** | Append-only log of agent/user/system messages on a run | Lives with the run. |
| **Output events** | High-frequency stream of CLI deltas/tool calls (harbour agents only) | Lives in `run_output`. Drives the SSE feed. |

Jobs come in two flavors:

- **Agent jobs** — `agent_id` is set. Always project-level. An LLM CLI runs them.
- **Workflows** — `kind = 'workflow'`, `agent_id IS NULL`. No LLM. Project-level or org-level (`project_id IS NULL`). See [Workflows](workflows.md).

Both kinds are picked up the same way: a runner claims due work via `POST /api/runner/claim` (the [Runner Protocol](../runner-guide.md)). The runner branches on `run.kind` — drive a CLI for agent runs, run the gate script for workflows.

Agent jobs can also define a prerun gate — a `{ runtime, content }` script (bash/python/node) that runs before the LLM and can skip the run.

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

Anything that doesn't match returns `null` and the API rejects it with 400. `POST /api/agents/:id/jobs`, `POST /api/jobs`, and `PUT /api/jobs/:id` write the normalized JSON.

Intervals are timezone-agnostic: every 5 minutes is every 5 minutes wall-clock. Weekly schedules use the system timezone for the day-of-week and time matching, and `getNextRunTime` walks forward up to 7 days, then wraps.

## Triggered runs

Most runs come from a recurring job firing on schedule. For an ad-hoc run, **trigger an existing job**: `POST /api/jobs/:id/trigger` with optional `{"instructions": "..."}`. It inserts a fresh `scheduled` run with `extra_instructions` saved on the run; the runner appends those to `job.instructions` and adds an "Additional instructions: ..." system activity entry. The recurring schedule keeps ticking — a triggered run is one extra firing on top of the regular cadence.

(v2 removed standalone "New Run" one-off creation; ad-hoc work is always a trigger on a job, so every run traces back to a job.)

## The unified claim

`claimNextRun(runner, capabilities)` is the single source of truth for work assignment — one org-agnostic path for both kinds, behind `POST /api/runner/claim`. It runs `reapStaleRuns` first, then a four-step ladder inside one **IMMEDIATE** transaction (so concurrent claims serialize on SQLite's single writer):

```
0. Fail any running run past its job's timeout (reapStaleRuns)
1. A 'pending' agent run to resume? (human responded) → flip to 'running', return it
2. A 'scheduled' run (either kind) due now? → claim it
3. A recurring agent job past next_run_at? → materialize a run, advance next_run_at
4. A recurring workflow job past next_run_at? → materialize a run, advance next_run_at
   (none claimable → { run: null })
```

A run is claimable only when its **placement** matches one of the runner's advertised labels, its **kind** (and, for agent runs, the agent's **CLI**) is one the runner advertised, and its **lock unit** has nothing in flight — `agent_id` for agent runs, `job_id` for workflow runs, where in-flight = `running | waiting | pending`. Distinct lock units run in parallel, unbounded by org; the *same* agent or workflow job never doubles up. Order matters within the ladder: pending always wins so a human reply doesn't get stuck behind tomorrow's recurring run.

Step 0 is important: if a previous `running` run is wedged past its job's `timeout_minutes`, the lock-unit check would otherwise gate that unit forever. `reapStaleRuns` checks `claimed_at + (timeout_minutes * 60) < now()` — a hard wallclock ceiling measured from when the current running attempt was claimed, deliberately **not** keyed on `updated_at` (streaming output refreshes `updated_at`, which would turn the check into a sliding inactivity window that never fires for a chatty-but-stuck run). Matches are force-failed with a system activity entry: "Run timed out after N minutes without completion."

`?peek=true` runs the same checks read-only (via `peekClaim`) — proving the runner's liveness and reporting availability without claiming.

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
| `scheduled` | Triggered (or recurring not-yet-claimed), waiting for `scheduled_for <= now`. Recurring schedule-trigger jobs may go straight to `running` on creation. |
| `running` | Agent is working. Activity is updating. Counts toward the "agent busy" check. |
| `waiting` | Agent paused for human input. Surfaces on the dashboard. Doesn't block other jobs from firing. |
| `pending` | Human responded — flipped automatically when a user posts activity to a `waiting`, `done`, `failed`, or `killed` run. Next poll claims it. |
| `done` | Completed successfully. Resumable via comment. |
| `failed` | Agent or workflow returned non-zero, or the run timed out. Resumable via comment or retry. |
| `skipped` | Workflow returned exit 77 — "nothing to do." Retryable, but not comment-resumable. |
| `killed` | A user clicked Kill on a harbour-agent run. Resumable via comment. |

When a run reaches any terminal status — `done`, `failed`, `skipped`, or `killed` — `updateRunStatus` advances the job's `next_run_at`. A kill ends this run, so the next scheduled occurrence should still fire; the user can also resume the killed run via a comment (the resume acts on the same run, and the in-flight lock keeps it from overlapping the next occurrence). Transitions are validated against a `LEGAL_RUN_TRANSITIONS` map at the single `updateRunStatus` chokepoint; an illegal edge returns **409**.

### Resume via comment

A user comment on a `waiting`, `done`, `failed`, or `killed` run flips it to `pending` (the activity route posts the comment, then calls `updateRunStatus`). A runner claims it at step 1 of the claim ladder on its next poll, with the full activity history — so "terminal" statuses other than `skipped` are really just paused: a human can always reopen the conversation. `skipped` runs are the exception (the gate said there was nothing to do); requeue one via retry instead.

### Timeouts

`jobs.timeout_minutes` defaults to 30. The runner enforces it as the CLI subprocess timeout. Harbour itself enforces it via `failStaleRuns`: if `claimed_at + timeout_minutes*60 < now`, the run is marked `failed` on the next poll. This is a hard wallclock ceiling per running attempt — `claimed_at` is stamped on every entry into `running` (the initial claim, and again on each `pending → running` resume), so a resumed run gets a fresh clock, but nothing resets it while the run stays `running`. It is deliberately not a sliding inactivity window keyed on `updated_at`: a run that keeps streaming output can still be wedged (looping, stuck repeating itself), and resetting the clock on activity would let it hold its agent forever. The ceiling guarantees a run can never stay `running` past `timeout_minutes`, so the agent is never gated indefinitely.

### Retry

```
POST /api/runs/:id/retry
```

Allowed for `failed`, `skipped`, and `killed` runs. An agent run flips to `pending` and the agent's next poll picks it up at step 2 of the ladder above; a workflow run is requeued as `scheduled` (with `scheduled_for = now`) so a workflow runner claims a fresh attempt. Both add a system activity entry. Retry doesn't reset the activity log — the agent sees the prior attempts in the run payload's `run.activity` and can act on them.

### Kill (harbour agents only)

```
POST /api/runs/:id/kill
```

Allowed on a `running` run. Sets `runs.kill_requested_at`; a Harbour runner polling the run picks up the flag and stops the CLI. The runner notices via two channels:

1. **Piggyback** — every `POST /api/runs/:id/output` flush returns `{kill_requested: bool}`. While the CLI streams, this is hot-path latency (~750ms).
2. **Fallback poll** — `GET /api/runs/:id/kill` every 10s. Catches stretches where the CLI is silent (long thinking, model-side stalls).

Either fires an `AbortController` that SIGTERMs the CLI, waits 3s, then SIGKILLs. The runner saves the CLI session ID, posts a "Run killed by user. Comment on this run to resume…" activity message, and sets status `killed`. A user comment flips it back through `pending → running` and resumes the CLI session.

An external agent doesn't poll the kill signal, so there's no process for Harbour to stop.

## What the agent gets

The run payload is one bundle: the run, the job, referenced docs, linked tables (each a name+id read reference), decrypted env vars, attachments, and an `api` section with pre-resolved endpoints and the allowed status options. See [guide.md](../guide.md) for the wire-level shape — that's what an agent reads at `/api/guide`.

A few invariants worth knowing:

- `job.instructions` already has any `extra_instructions` from a triggered run appended underneath a `---` separator (`buildRunPayload`).
- `env` is decrypted at payload-build time. The dashboard can't see plaintext after creation, but the agent does on each poll.
- `attachments` is the full list (files + URL embeds). Files have a download URL the agent can fetch with the same Bearer token.

## Source-of-truth pointers

- `src/lib/db/jobs.ts` — `createJob`, `createWorkflow`, `updateJob`, `triggerJobRun`, `advanceJobSchedule`.
- `src/lib/db/runs.ts` — the unified claim (`claimNextRun`, `peekClaim`), `reapStaleRuns`, `updateRunStatus`, `requestKillRun`, `mintExecToken`, `buildRunPayload`.
- `src/lib/schedule.ts` — `normalizeSchedule` (the human-readable / cron parser) and `getNextRunTime` (timezone-aware advancer).
- `src/lib/db/schema.ts` — the `runs` CHECK constraint and the `jobs` columns that drive triggers.
- `src/app/api/runs/[id]/status/route.ts` — status transitions.
- `src/app/api/runs/[id]/kill/route.ts` and `src/app/api/runs/[id]/retry/route.ts` — terminal-state operations.
- `guide.md` — the wire contract an agent reads at `/api/guide`.
