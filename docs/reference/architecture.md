# Architecture

A 30-minute orientation for someone digging in. Pointer-rich, not exhaustive —
for the exact schema see [database-schema.md](database-schema.md), for the route
map see [api.md](api.md), for on-the-wire payloads see
[guide.md](../guide.md) / [management-guide.md](../management-guide.md).

## Overview

Harbour is a **single Next.js process** plus a **single SQLite file**. No Redis,
no message queue, no separate worker pool. Recurring work becomes rows in `runs`;
a **runner** polls one HTTP endpoint (`POST /api/runner/claim`) to claim it. State
changes happen inside SQLite transactions, so the claim path is atomic without
external coordination.

The hierarchy is **flat**: instance → **projects** → agents & jobs → runs, and
every agent, job, doc, secret, and table lives inside exactly one project.
There are no orgs, no memberships, no roles — every authenticated user may do
everything. Harbour never calls out to agents — everything is pull.

Everything an installation needs lives under one directory (`~/.harbour/` by
default):

| Path | Contents |
|---|---|
| `harbour.db` (+ `-wal`, `-shm`) | SQLite database (WAL mode) |
| `encryption.key` | hex key for env-var AES-256-GCM (mode 0600) |
| `uploads/runs/<runId>/` | run attachment files |
| `runner.token` | the runner's bearer token (`hbrn_…`), the **only** secret the runner keeps on disk (mode 0600, like `encryption.key`); its absence means the runner is unprovisioned. The DB `runners` table is the registry — there is no local runner registry file |
| `runner.url` (optional) | non-secret base URL the runner reaches Harbour at; resolution order is `HARBOUR_URL` env → `HARBOUR_PORT` local override → this file → the shared local default `http://127.0.0.1:4272` (`PORT` is server-only at runtime) |
| `sessions.json` | CLI session cache for run resume (`run_id → {sessionId, cli, cwd}`) |
| `workflows/` | working root under which each job's gate scripts (workflow command, agent prerun/postrun) are materialized; the runner writes a gate's body to a per-job subdir (`<scripts_dir>`) from the payload, then runs it via its runtime's interpreter |
| `runner.log`, `runner.err.log` | launchd output for the runner |

Override roots via `HARBOUR_HOME`, `HARBOUR_DB_PATH`, `HARBOUR_UPLOADS_DIR`,
`HARBOUR_ENCRYPTION_KEY`, `HARBOUR_MAX_UPLOAD_MB` (default 500) — see
`src/lib/paths.ts`. `HARBOUR_SESSION_TTL_DAYS` (default 30) lives in
`src/lib/db/users.ts`.

## Tech stack

Load-bearing dependencies (authoritative versions live in `package.json`):

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) |
| UI runtime | React 19 |
| Styling | Tailwind v4 (oklch color space, CSS-variable theming) |
| Components | shadcn/ui on `@base-ui/react` |
| DB driver | better-sqlite3 |
| Password hashing | `@node-rs/argon2` (argon2id) |
| Client state | TanStack Query (React Query) |
| Multipart upload | busboy |
| Tests | Vitest (+ `@playwright/test`) |

The repo ships a tiny CLI: `npm run harbour -- ...` resolves to `bin/harbour.mjs`,
which dispatches to the runner library under `bin/lib/`.

## Auth model

`src/lib/auth.ts` resolves an **identity** from a request
(`getIdentityFromRequest`). Bearer tokens dispatch by prefix; the three core
identities are:

1. **User session** — the `harbour_session` cookie (HttpOnly, SameSite=Lax,
   `Secure` keyed to the request protocol via `isHttpsRequest`; lifetime
   `HARBOUR_SESSION_TTL_DAYS`, default 30). Set at `POST /api/auth/login`,
   which throttles failed attempts (5 per email+IP per 15 minutes → `429`).
2. **Runner token** (`hbrn_…`) — `Authorization: Bearer <token>`, sha256-hashed
   in `runners.token_hash`. Authenticates a registered runner for the claim
   endpoint only; carries the runner's tier, authorized labels, and optional scope.
3. **Run exec token** (`hbx_…`) — minted per run at claim, hashed in
   `runs.exec_token_hash`. The run-scoped credential the runner hands the CLI it
   spawns, so the high-value runner token never reaches the CLI; bound to exactly
   one run and rotated on every re-claim.

Agents have **no credential of their own**: a runner claims their runs and the
spawned CLI authenticates *as the run* via its exec token (above), so the
docs/tables/data routes accept that exec token, not an agent key. An **API key**
(`hbr_…`) resolves to the *creating user's* identity — it acts as that user, and
is the only `hbr_` Bearer the server accepts.

**Authentication is the whole story** — there are no roles and no tenancy, so
any user identity is authorized for every user-facing route. Every route is
wrapped in exactly **one** of four HOFs from `auth.ts` (no inline checks):

| Wrapper | Who passes |
|---|---|
| `withAuthenticatedUser` | any signed-in user (session or API key) — the standard wrapper for every dashboard/API route |
| `withRunnerAuth` | runner token only — the claim endpoint (`/api/runner/claim`); the handler receives the runner's tier/labels/scope |
| `withRunExecutorOrUser` | the run's **exec token** (must match the route's `id` param) **or** any user — the run-lifecycle routes (status/activity/output/kill/title/session/attachments) |
| `withAgentOrUser` | any user, **or** an agent-run **executor** token acting as the run's agent — the resource routes both dashboards and agents call (docs create/update, tables + rows + columns, trigger) |

Two token-confinement invariants hold everywhere:

1. **An exec token is bound to exactly one run.** `withRunExecutorOrUser`
   rejects an executor whose `runId` differs from the route's `id` param, so a
   leaked token grants no cross-run access.
2. **An executor acts as its agent only while the run is executing.**
   `withAgentOrUser` requires an agent-run executor (a workflow run's executor
   has no agent identity and is rejected) and rejects exec tokens of
   terminal runs (`done`/`failed`/`skipped`/`killed`) — a lingering token can't
   keep writing the agent's docs/tables after the work turn.

`[id]` routes return **404** for a missing resource — there is no
existence-hiding 403 (nothing to hide with no tenants).

First-run setup is a shell flow (`harbour setup` — creates the first user and
provisions the local runner; `harbour user create` is the non-interactive form,
reading `HARBOUR_USER_PASSWORD` if set); there is **no web signup**.
The public routes are `POST /api/auth/{login,logout,set-password}`,
`GET /api/auth/me` (identity echo; 401 when unauthenticated),
`GET /api/guide`, and `GET /api/runner-guide`.

## The unified claim

There's **one** execution entry point: `POST /api/runner/claim`
(`withRunnerAuth`, runner token only). A runner POSTs its live capabilities —
`{ kinds, clis, labels }` — and the server returns the next claimable run
(kind-tagged, with a freshly minted exec token and a pre-resolved `api` block) or
`{ run: null }`. `?peek=true` proves liveness and reports availability without
claiming. The whole thing runs in `claimNextRun` (`src/lib/db/runs.ts`).

The server is the sole arbiter. A run is claimable when:

- **Due** — a `scheduled` run whose `scheduled_for <= now`, an agent run a human
  nudged back to `pending` to resume, or a recurring job past its `next_run_at`
  (materialized into a run in the same transaction).
- **Placement matches** — the run's `placement` is one of the runner's advertised
  labels (and, for a remote-tier token, a label it's *authorized* for).
- **Capability matches** — the run's `kind` is in `capabilities.kinds`, and for
  agent runs the agent's `cli` is in `capabilities.clis`.
- **Lock unit is idle** — nothing else for that lock unit is in flight. The lock
  unit is `agent_id` for agent runs and `job_id` for workflow runs; in-flight
  means status `running` or `pending`. A `waiting` run (paused for human review)
  is *not* in flight — it has no timeout, so letting it hold the lock would strand
  the agent's other work indefinitely (#50). Distinct lock units run in
  parallel, capped only by the runner's pool size.

Atomicity: the dueness check, placement/capability/lock-unit filters, recurring
materialization, and the guarded status flip (`UPDATE … SET status = 'running' …
WHERE id = ? AND status = ?`, bailing if `changes !== 1`) all run in **one
`IMMEDIATE` SQLite transaction**. Concurrent claims serialize on the single
writer, so two runners racing can't double-claim — "claims serialize for free."

## Run lifecycle

```
                                +-- done     (terminal; postrun gate may override to failed)
                                +-- failed   (terminal)
                                +-- skipped  (terminal; prerun/workflow exit 77)
                                +-- killed   (terminal; SIGTERM, resumable via comment)
scheduled --> running ----------+
   ^             |              |
   |             +-- waiting -- pending --> running --> ...
   |                                ^
   +-- (one-off/recurring create)   +-- user comment on waiting/done/failed/killed
```

- **`scheduled`** — a one-off/triggered run with a future `scheduled_for`, or a
  recurring job firing.
- **`running`** — claimed; sets `claimed_at`, `claimed_by`, and the run's
  `exec_token_hash`. Other queued runs for the same lock unit wait behind it.
- **`waiting`** — the agent paused for human input. **`pending`** — a human
  responded (comment or retry); the next claim picks it up as a resume.
- **`done` / `failed` / `skipped` / `killed`** — terminal; set `completed_at` and
  advance the job's `next_run_at`. A kill ends this run, so the next scheduled
  occurrence still fires; the user can also resume the killed run via a comment
  (the in-flight lock keeps the resumed run and the next occurrence from overlapping).

The lifecycle also drives the run's cumulative metrics: each entry into
`running` increments `runs.attempts`, and every exit from `running` (waiting
included — the finalize turn's exit too) folds `now − claimed_at` into
`runs.duration_seconds` inside the same status UPDATE. Token usage arrives
separately: the bundled runner posts each CLI turn's delta to
`POST /api/runs/:id/usage` and the server accumulates it (`addRunUsage`).

Transitions are **mechanically enforced**: `updateRunStatus` (the
single chokepoint) validates against a `LEGAL_RUN_TRANSITIONS` map and throws
`IllegalRunStatusTransition`; `PUT /api/runs/:id/status` returns **409** for an
illegal edge (vs 400 for a bad enum value). `createRun`/`requeueWorkflowRun` are
documented direct-write bypasses.

The lifecycle endpoints the runner drives during a run
(`title`/`status`/`activity`/`output`/`kill`/`session`/`usage`/`attachments`) authenticate
with that run's **exec token** (`withRunExecutorOrUser` — the token is bound to a
single run id; any authenticated user also passes).

### The kill flow

The dashboard **Kill** button writes `runs.kill_requested_at`. The runner
notices two ways: **piggyback** — every `POST /api/runs/:id/output` response
includes `kill_requested` (≤ one ~750ms flush); and a **fallback poll** of
`GET /api/runs/:id/kill` every 10s when the CLI is silent. The runner sends
SIGTERM, waits a grace period, then SIGKILL, and saves the CLI session id to
`runs.session_id` so a comment can resume the run.

## Runner architecture

The runner is a **separate Node CLI**, not the Next.js process. There is **one**
runner and **one** command, `harbour run` — it drives both agent jobs and
workflows. A single service runs it on a tick: launchd
(macOS) invokes it every 60s (`com.harbour.runner`, `StartInterval=60`); the
systemd variant loops with `sleep 60`. Each invocation drains all currently-due
work and exits.

```
launchd (macOS, StartInterval=60) / systemd loop (Linux)
  -> node bin/harbour.mjs run
       -> bin/lib/runner.mjs : runPool()
            load ~/.harbour/runner.token + base URL, detectCapabilities()
            loop: claimOne() -> POST /api/runner/claim {capabilities}
                  dispatch() branches on job.kind, up to POOL_SIZE in parallel:
                    kind=agent    -> processNextRun()      (drive a CLI session)
                    kind=workflow -> processNextWorkflow() (run the gate script)
            drains all due work this cycle (cap MAX_CLAIMS_PER_CYCLE), then exits
```

A cycle tops up a pool of in-flight tasks: it claims while the pool has room
(`POOL_SIZE`, default 4, `HARBOUR_POOL_SIZE` override; `MAX_CLAIMS_PER_CYCLE`
backstop), runs distinct lock units concurrently, and stops when a claim returns
`{ run: null }` and the pool has drained. Each claimed payload carries its own
per-run **exec token**, which `dispatch` hands the executor as the Bearer for
every `/api/runs/:id/*` callback — the high-value runner token never reaches a
CLI or a gate. The same `runPool` path serves both the local runner and a remote
one; only which token `loadRunnerCredentials` returns differs.

| File | Role |
|---|---|
| `bin/harbour.mjs` | CLI dispatcher (`run`, `connect`, `install`, `uninstall`, `status`, plus `start`/`dev`/`setup`/`user`) |
| `bin/lib/runner.mjs` | `runPool` (drain loop) → `claimOne` (claim) + `dispatch` (kind branch); the `processNextRun` / `processNextWorkflow` executors; prompt assembly, kill plumbing, session save |
| `bin/lib/providers.mjs` | `detectCapabilities` (host `kinds`/`clis`/`labels`) and the per-CLI provider: command building, JSONL parsing, SIGTERM/SIGKILL grace |
| `bin/lib/policy.mjs` | `resolveAgentPolicy` — pre-spawn permission-policy resolution (fail closed) + the workspace trust bootstrap |
| `bin/lib/install.mjs` | launchd plist install/uninstall for the single `com.harbour.runner` service |
| `bin/lib/connect.mjs` | `connectRunner` — decode `harbour connect <blob>`, peek-verify, write the token + url |
| `bin/lib/config.mjs` | read/write `runner.token` (+ `runner.url`) and `sessions.json`; `printRunnerStatus` |
| `bin/lib/bootstrap.mjs` | `harbour setup` / `harbour user create` (argon2id, direct DB) |

**Remote enrollment.** `harbour connect <blob>` enrolls a runner on another host
from a minted credential blob (`{url, token, name}`): it peek-verifies via
`POST /api/runner/claim?peek=true` advertising the host's capabilities, then
writes the token (0600) and URL. The local runner's token is provisioned by
`harbour setup` instead. (The exact minting flow lands in a later chunk.)

**Providers.** Permission flags are decided *before* spawn: the runner resolves
the agent's `permissions` setting against the workspace policy file
(`resolveAgentPolicy`, `bin/lib/policy.mjs`) and only then builds the command.
Enforced (the default) requires a valid CLI-native policy file — missing or
invalid, the run **fails closed** with the reason as activity and the CLI is
never spawned; enforced runs also get a pre-spawn trust bootstrap (both CLIs
honor a workspace's policy only when the host marks that directory trusted).
Unrestricted agents keep the legacy bypass flags. Exact flags, file formats,
and checks: [agent permissions](../guides/agent-permissions.md).

Both providers normalize to the event vocab
`text_delta`/`thinking`/`tool_start`/`tool_end`/`info`/`result`/`error`, batched
to the server every ~750ms and replayed to the dashboard via SSE.

**Sessions & workspaces.** Each agent runs its CLI in
`~/.harbour/workspaces/<project-slug>/<agent-slug>/`, built from the
payload's `workspace` block of immutable slugs (segments validated against
`^[a-z0-9-]+$` — see
[agents.md](../concepts/agents.md#workspaces)); session ids and the run's cwd
are cached in `sessions.json` (`run_id → {sessionId, cli, cwd}`) to resume
killed/waiting runs in place. Draining all due work each cycle subsumes the old
per-agent eager loop — a cycle just keeps claiming until nothing is claimable, so
an agent with backlogged runs works through them within one tick without a
dedicated loop. (The `agents.eager` flag still rides in the payload but is
effectively a no-op at the runner now.)

**Env layering.** Before spawning, the runner strips Claude Code nesting guards,
then layers the job's decrypted env vars onto the process environment so the
agent's shell can expand `$VAR` natively — with the `HARBOUR_URL` /
`HARBOUR_RUN_ID` / `HARBOUR_API_KEY` trio layered last so a job secret can't
shadow the reporting channel (`buildRunEnv`). Captured output is redacted
against the run's known secret values as defense-in-depth.

**Prompt assembly.** The work prompt is built fresh per turn (`buildPrompt` in
`bin/lib/runner.mjs`), sections in this order: job name → instructions → linked
docs (full content inlined) → linked tables (ids only, rows via API) → activity
log (attachments rendered inline under the entry they arrived with) → orphan
attachments → job env var *names* (values only in the environment) → the
Harbour API section (`harbour update` + the curl endpoints); prerun output,
when a gate ran, is appended after all of that. A **resume** turn sends only
the human's new messages plus the API section — the resumed CLI session
already holds the rest. Resume is keyed off the *saved session*, not the run
state: with no compatible session saved (lost, or the agent's `cli` changed),
a pending run gets a fresh session with the full prompt instead. Anything the
CLI knows beyond this prompt and env came from its own native context loading
— see [context files and CLI state](../concepts/agents.md#context-files-and-cli-state).

## Frontend

Two App Router route groups:

- **`src/app/(auth)/`** — `login/`, `set-password/`. Public; no shell.
- **`src/app/(app)/`** — the dashboard, wrapped in `AppShell`:
  `runs/` (root dashboard), `jobs/`, `agents/`, `docs/`, `tables/`,
  `env-vars/` (labeled **Secrets**), `users/`, `settings/`.

`AppShell` (`src/components/app/app-shell.tsx`) does the auth check
(`/api/auth/me` → redirect on 401), the **project switcher** (active project in
`localStorage["harbour_active_project"]`; no selection = all projects),
sidebar/mobile nav, theme toggle, and the waiting-runs badge. Switching project
invalidates all React Query keys.

React Query defaults: `staleTime: 2000`, `refetchOnWindowFocus: true`; most lists
`refetchInterval` ~5s, the sidebar projects ~10s. SSE (`/api/runs/:id/output/stream`)
replaces polling once a CLI is actively streaming. Theming is
oklch CSS variables with Light/Dark/System, persisted to
`localStorage["harbour_theme"]`. Mobile uses the `md:` breakpoint (fixed sidebar
→ top header + bottom tab bar). Available as a PWA (`display: standalone`, no
service worker).

## Source-of-truth pointers

Read these in order:

1. `src/lib/db/schema.ts` — every table; the schema *is* the file.
2. `src/lib/auth.ts` — identity resolution and the four wrappers above.
3. `src/lib/db/runs.ts` — `claimNextRun`/`peekClaim` (the unified claim,
   placement/capability/lock-unit filters, the guarded flip), exec-token minting,
   the `updateRunStatus` transition map, and the kill flow.
4. `src/lib/db/jobs.ts` — schedule advance, job-creation transactions.
5. `src/app/api/runner/claim/route.ts` — the server side of the claim and the
   `api` block (with the per-run exec token) that travels with each payload.
6. `bin/lib/runner.mjs` + `bin/lib/providers.mjs` — the client side of the runner
   (`runPool` drain, `claimOne`/`dispatch`, the kind executors), prompt assembly,
   kill, capability detection, and per-CLI parsing.
7. `bin/lib/bootstrap.mjs` — first-run user creation.
8. `docs/guide.md` / `docs/management-guide.md` / `docs/runner-guide.md` — wire
   contracts, live-served on `/api/guide`, `/api/management-guide`, and
   `/api/runner-guide`.
9. `src/lib/schedule.ts` — interval / weekly parsing and timezone math
   (the instance timezone comes from the `settings` KV via `getTimezone()`).
