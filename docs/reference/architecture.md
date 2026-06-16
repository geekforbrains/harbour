# Architecture

A 30-minute orientation for someone digging in. Pointer-rich, not exhaustive —
for the exact schema see [database-schema.md](database-schema.md), for the route
map see [api.md](api.md), for on-the-wire payloads see
[guide.md](../guide.md) / [admin-guide.md](../admin-guide.md).

## Overview

Harbour is a **single Next.js process** plus a **single SQLite file**. No Redis,
no message queue, no separate worker pool. Recurring work becomes rows in `runs`;
a **runner** polls one HTTP endpoint (`POST /api/runner/claim`) to claim it. State
changes happen inside SQLite transactions, so the claim path is atomic without
external coordination.

It is **multi-tenant**: an instance admin owns the install, work is organized
into **orgs → projects**, and every agent, job, doc, secret, and table lives
inside a project. Resources never cross org lines. Harbour never calls out to
agents — everything is pull.

Everything an installation needs lives under one directory (`~/.harbour/` by
default):

| Path | Contents |
|---|---|
| `harbour.db` (+ `-wal`, `-shm`) | SQLite database (WAL mode) |
| `encryption.key` | hex key for env-var AES-256-GCM (mode 0600) |
| `uploads/runs/<runId>/` | run attachment files |
| `runner.token` | the runner's bearer token (`hbrn_…`), the **only** secret the runner keeps on disk (mode 0600, like `encryption.key`); its absence means the runner is unprovisioned. The DB `runners` table is the registry — there is no local runner registry file |
| `runner.url` (optional) | non-secret base URL the runner reaches Harbour at; resolution order is `HARBOUR_URL` env → this file → `http://localhost:3000` |
| `sessions.json` | CLI session cache for run resume (`run_id → {sessionId, cli, cwd}`) |
| `workflows/` | working root under which each job's gate scripts (workflow command, agent prerun/postrun) are materialized; the runner writes a gate's body to a per-job subdir (`<scripts_dir>`) from the payload, then runs it via its runtime's interpreter |
| `captain/` | Captain conversation workspace (default cwd) |
| `runner.log`, `runner.err.log` | launchd output for the runner |

Override roots via `HARBOUR_HOME`, `HARBOUR_DB_PATH`, `HARBOUR_UPLOADS_DIR`,
`HARBOUR_ENCRYPTION_KEY`, `HARBOUR_MAX_UPLOAD_MB` (default 500) — see
`src/lib/paths.ts`. `HARBOUR_SESSION_TTL_DAYS` (default 30) lives in
`src/lib/db/users.ts`.

## Tech stack

Load-bearing dependencies (authoritative versions live in `package.json`):

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router, `output: standalone`) |
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

An **agent API key** (`hbr_…`) still resolves — sha256-hashed in
`agents.api_key_hash`, carrying the agent's home project — but only for the
docs/tables/data routes the CLI calls; agents no longer poll for work. An
**admin API key** uses the same `hbr_` Bearer header but resolves to the
*creating user's* identity — it acts as that user.

**Authorization** is layered on top by role. Roles (`src/lib/db/access.ts`):
`viewer < editor < instance_admin`. `resolveAccess(userId, orgId)` returns
`instance_admin` for any org if `users.is_instance_admin`, else the
`memberships` role for that org, else `null`. `meets(role, min)` does the rank
check.

Every route is wrapped in exactly one HOF from `auth.ts` (no inline checks):

| Wrapper | Who passes | Scope source |
|---|---|---|
| `withInstanceAdmin` | instance admin only | — (spans all orgs) |
| `withOrgAuth(h, {role})` | user meeting `role` in the org | `?orgId=` or `harbour_org` cookie |
| `withProjectAuth(h, {role})` | user meeting `role` in the project's org | `?projectId=` → owning org |
| `withResourceAuth(kind, idParam, {role})` | user meeting `role` in the resource's org | `orgIdForResource(kind, id)` |
| `withAuthenticatedUser` | any signed-in user (no org scope) | system info routes |
| `withRunnerAuth` | runner token only | the claim endpoint (`/api/runner/claim`) |
| `withRunExecutorOrUser(h, {role})` | the run's **exec token** (bound to that run id) **or** a user meeting `role` in the run's org | run's org |
| `withAgentOrUser(h, {role, orgFromParams?})` | user **or** agent — where "agent" is a permanent agent key **or** an agent-run **executor** token acting as the run's agent | per-identity |

`withAgentOrUser` narrows an agent (or agent-run executor) to its own org inline:
for `[id]` routes it resolves the target org via `orgFromParams` and rejects
anything outside the agent's org. Cross-org or missing resources resolve to
**403**, not 404, so existence doesn't leak across tenants.

First-run setup is a shell flow (`harbour setup`); there is **no web signup**.
The public routes are `POST /api/auth/{login,logout,set-password}`,
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
  means status `running`, `waiting`, or `pending`. Distinct lock units run in
  parallel (unbounded by org, capped only by the runner's pool size).

Atomicity: the dueness check, placement/capability/lock-unit filters, recurring
materialization, and the guarded status flip (`UPDATE … SET status = 'running' …
WHERE id = ? AND status = ?`, bailing if `changes !== 1`) all run in **one
`IMMEDIATE` SQLite transaction**. Concurrent claims serialize on the single
writer, so two runners racing can't double-claim — "claims serialize for free."

## Run lifecycle

```
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
- **`done` / `failed` / `skipped` / `killed`** — terminal; set `completed_at`.
  `done`/`failed`/`skipped` advance the job's `next_run_at`; `killed` does **not**
  (the user stopped it intentionally and may resume).

Unlike v1, transitions are **mechanically enforced**: `updateRunStatus` (the
single chokepoint) validates against a `LEGAL_RUN_TRANSITIONS` map and throws
`IllegalRunStatusTransition`; `PUT /api/runs/:id/status` returns **409** for an
illegal edge (vs 400 for a bad enum value). `createRun`/`requeueWorkflowRun` are
documented direct-write bypasses.

The lifecycle endpoints the runner drives during a run
(`title`/`status`/`activity`/`output`/`kill`/`session`/`attachments`) authenticate
with that run's **exec token** (`withRunExecutorOrUser` — the token is bound to a
single run id, or a user meeting the route's role in the run's org also passes).

### The kill flow

The dashboard **Kill** button writes `runs.kill_requested_at`. The runner
notices two ways: **piggyback** — every `POST /api/runs/:id/output` response
includes `kill_requested` (≤ one ~750ms flush); and a **fallback poll** of
`GET /api/runs/:id/kill` every 10s when the CLI is silent. The runner sends
SIGTERM, waits a grace period, then SIGKILL, and saves the CLI session id to
`runs.session_id` so a comment can resume the run.

## Runner architecture

The runner is a **separate Node CLI**, not the Next.js process. There is **one**
runner and **one** command, `harbour run` — it replaces the two former runners
(`agent run` + `workflow run`). A single service runs it on a tick: launchd
(macOS) invokes it every 60s (`com.harbour.runner`, `StartInterval=60`); the
systemd variant loops with `sleep 60`. Each invocation drains all currently-due
work and exits.

```
launchd (com.harbour.runner, StartInterval=60)
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
| `bin/harbour.mjs` | CLI dispatcher (`run`, `connect`, `install`, `uninstall`, `status`, plus `start`/`dev`/`setup`/`admin`) |
| `bin/lib/runner.mjs` | `runPool` (drain loop) → `claimOne` (claim) + `dispatch` (kind branch); the `processNextRun` / `processNextWorkflow` executors; prompt assembly, kill plumbing, session save |
| `bin/lib/providers.mjs` | `detectCapabilities` (host `kinds`/`clis`/`labels`) and the per-CLI provider: command building, JSONL parsing, SIGTERM/SIGKILL grace |
| `bin/lib/install.mjs` | launchd plist install/uninstall for the single `com.harbour.runner` service |
| `bin/lib/connect.mjs` | `connectRunner` — decode `harbour connect <blob>`, peek-verify, write the token + url |
| `bin/lib/config.mjs` | read/write `runner.token` (+ `runner.url`) and `sessions.json`; `printRunnerStatus` |
| `bin/lib/bootstrap.mjs` | `harbour setup` / `harbour admin create` (argon2id, direct DB) |

**Remote enrollment.** `harbour connect <blob>` enrolls a runner on another host
from a minted credential blob (`{url, token, name}`): it peek-verifies via
`POST /api/runner/claim?peek=true` advertising the host's capabilities, then
writes the token (0600) and URL. The local runner's token is provisioned by
`harbour setup` instead. (The exact minting flow lands in a later chunk.)

**Providers.** `claude` runs `--output-format stream-json --verbose`, with
`--dangerously-skip-permissions` *unless* the agent workspace has a valid
`.claude/settings.json` with a `permissions` object (then the permission system
runs); `codex` runs `exec --dangerously-bypass-approvals-and-sandbox --json`;
`gemini` runs `--yolo -o stream-json`. All three normalize to the event vocab
`text_delta`/`thinking`/`tool_start`/`tool_end`/`info`/`result`/`error`, batched
to the server every ~750ms and replayed to the dashboard via SSE.

**Sessions & workspaces.** Each agent runs its CLI in
`~/.harbour/workspaces/<org-slug>/<project-slug>/<agent-slug>/`, built from the
payload's `workspace` block of immutable slugs (segments validated against
`^[a-z0-9-]+$`; legacy flat fallback for older servers — see
[agents.md](../concepts/agents.md#workspaces)); session ids and the run's cwd
are cached in `sessions.json` (`run_id → {sessionId, cli, cwd}`) to resume
killed/waiting runs in place. Draining all due work each cycle subsumes the old
per-agent eager loop — a cycle just keeps claiming until nothing is claimable, so
an agent with backlogged runs works through them within one tick without a
dedicated loop. (The `agents.eager` flag still rides in the payload but is
effectively a no-op at the runner now.)

**Env layering.** Before spawning, the runner strips Claude Code nesting guards,
then layers the job's decrypted env vars onto the process environment so the
agent's shell can expand `$VAR` natively. (Hardening the rest of this allowlist
is a [PRD](../prd.md) §6 requirement — H4.)

## Frontend

Two App Router route groups:

- **`src/app/(auth)/`** — `login/`, `set-password/`. Public; no shell.
- **`src/app/(app)/`** — the dashboard, wrapped in `AppShell`: `captain/`,
  `runs/` (root dashboard), `jobs/`, `agents/`, `docs/`, `tables/`,
  `env-vars/` (labeled **Secrets**), `users/`, `settings/`.

`AppShell` (`src/components/app/app-shell.tsx`) does the auth check
(`/api/auth/me` → redirect on 401), the **org switcher** + **project switcher**
(active org in the `harbour_org` cookie, active project in
`localStorage["harbour_active_project"]`), sidebar/mobile nav, theme toggle, and
the waiting-runs badge. Switching org/project invalidates all React Query keys.

React Query defaults: `staleTime: 2000`, `refetchOnWindowFocus: true`; most lists
`refetchInterval` ~5s, the sidebar projects ~10s. SSE (`/api/runs/:id/output/stream`,
captain stream) replaces polling once a CLI is actively streaming. Theming is
oklch CSS variables with Light/Dark/System, persisted to
`localStorage["harbour_theme"]`. Mobile uses the `md:` breakpoint (fixed sidebar
→ top header + bottom tab bar). Available as a PWA (`display: standalone`, no
service worker).

## Source-of-truth pointers

Read these in order:

1. `src/lib/db/schema.ts` — every table; the schema *is* the file.
2. `src/lib/db/access.ts` — roles, `resolveAccess`, `orgIdForResource`.
3. `src/lib/auth.ts` — identity resolution and the wrapper set above.
4. `src/lib/db/runs.ts` — `claimNextRun`/`peekClaim` (the unified claim,
   placement/capability/lock-unit filters, the guarded flip), exec-token minting,
   the `updateRunStatus` transition map, and the kill flow.
5. `src/lib/db/jobs.ts` — schedule advance, job-creation transactions.
6. `src/app/api/runner/claim/route.ts` — the server side of the claim and the
   `api` block (with the per-run exec token) that travels with each payload.
7. `bin/lib/runner.mjs` + `bin/lib/providers.mjs` — the client side of the runner
   (`runPool` drain, `claimOne`/`dispatch`, the kind executors), prompt assembly,
   kill, capability detection, and per-CLI parsing.
8. `bin/lib/bootstrap.mjs` — first-run admin creation.
9. `docs/guide.md` / `docs/admin-guide.md` / `docs/runner-guide.md` — wire
   contracts, live-served on `/api/guide`, `/api/admin-guide`, and
   `/api/runner-guide`.
10. `src/lib/schedule.ts` — interval / weekly parsing and timezone math.
