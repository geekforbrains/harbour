# Architecture

A 30-minute orientation for someone digging in. Pointer-rich, not exhaustive —
for the exact schema see [database-schema.md](database-schema.md), for the route
map see [api.md](api.md), for on-the-wire payloads see
[guide.md](../guide.md) / [admin-guide.md](../admin-guide.md).

## Overview

Harbour is a **single Next.js process** plus a **single SQLite file**. No Redis,
no message queue, no separate worker pool. Recurring work becomes rows in `runs`;
an agent (or workflow runner) polls an HTTP endpoint to claim it. State changes
happen inside SQLite transactions, so the claim path is atomic without external
coordination.

It is **multi-tenant**: an instance admin owns the install, work is organized
into **orgs → projects**, and every agent, job, doc, secret, and database lives
inside a project. Resources never cross org lines. Harbour never calls out to
agents — everything is pull.

Everything an installation needs lives under one directory (`~/.harbour/` by
default):

| Path | Contents |
|---|---|
| `harbour.db` (+ `-wal`, `-shm`) | SQLite database (WAL mode) |
| `encryption.key` | hex key for env-var AES-256-GCM (mode 0600) |
| `uploads/runs/<runId>/` | run attachment files |
| `runners.json` | agent runner config (agent → CLI tool mapping) |
| `workflow-runners.json` | workflow runner credentials |
| `sessions.json` | CLI session cache for run resume |
| `workflows/` | working root for workflow commands and agent prerun/postrun gates; jobs with scripts get a per-job subdir (`<scripts_dir>`) the runner materializes from the payload, jobs without scripts run from the flat root (operator hand-places files there) |
| `captain/` | Captain conversation workspace (default cwd) |
| `runner.log`, `runner.err.log` | launchd output for the agent runner |

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

`src/lib/auth.ts` resolves one of three **identities** from a request
(`getIdentityFromRequest`):

1. **User session** — the `harbour_session` cookie (HttpOnly, SameSite=Lax,
   `Secure` keyed to the request protocol via `isHttpsRequest`; lifetime
   `HARBOUR_SESSION_TTL_DAYS`, default 30). Set at `POST /api/auth/login`,
   which throttles failed attempts (5 per email+IP per 15 minutes → `429`).
2. **Agent API key** — `Authorization: Bearer <key>`, sha256-hashed in
   `agents.api_key_hash`. Carries the agent's home project.
3. **Workflow-runner key** — same header, hashed in
   `workflow_runners.api_key_hash`. Org-scoped.

An **admin API key** also uses the Bearer header but resolves to the *creating
user's* identity — it acts as that user.

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
| `withAgentAuth` | agent key only | agent's project → org |
| `withWorkflowRunnerAuth` | workflow-runner key only | runner's org |
| `withAgentOrUser(h, {role, allowWorkflowRunner?, orgFromParams?})` | user **or** agent (optionally workflow runner) | per-identity |

Two in-handler ownership guards narrow agent scope further:
`requireAgentProject(auth, kind, id)` (the resource must live in the agent's org)
and `requireAgentSelf(auth, agentId)` (the `/next` route — an agent polls only
itself). Cross-org or missing resources resolve to **403**, not 404, so existence
doesn't leak across tenants.

First-run setup is a shell flow (`harbour setup`); there is **no web signup**.
The public routes are `POST /api/auth/{login,logout,set-password}` and
`GET /api/guide`.

## Polling ladder

When a runner GETs `/api/agents/:id/next`, the server runs a priority ladder
inside one transaction (`getAgentNextRun`, `src/lib/db/runs.ts`). Steps fall
through if they don't match:

```
Step 0  Fail any 'running' runs past job.timeout_minutes (failStaleRuns)
Step 1  Agent already has a 'running' run? -> return null (busy)
Step 2  'pending' run for this agent? -> guarded flip to 'running', return it
Step 3  'scheduled' run with scheduled_for <= now? -> claim, return it
Step 4  Recurring job past next_run_at? -> create run, advance schedule
```

The claim UPDATEs are guarded (`AND status = 'pending'/'scheduled'`) and bail if
`changes !== 1`, so two runners racing under `busy_timeout` can't double-claim.
`getNextWorkflowRun` runs the same shape for `kind='workflow'` jobs, exposed at
`/api/workflows/next` with workflow-runner credentials. `?peek=true` runs the
checks without claiming.

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
- **`running`** — claimed; sets `claimed_at`. Other queued runs wait behind it.
- **`waiting`** — the agent paused for human input. **`pending`** — a human
  responded (comment or retry); step 2 of the ladder picks it up.
- **`done` / `failed` / `skipped` / `killed`** — terminal; set `completed_at`.
  `done`/`failed`/`skipped` advance the job's `next_run_at`; `killed` does **not**
  (the user stopped it intentionally and may resume).

Unlike v1, transitions are **mechanically enforced**: `updateRunStatus` (the
single chokepoint) validates against a `LEGAL_RUN_TRANSITIONS` map and throws
`IllegalRunStatusTransition`; `PUT /api/runs/:id/status` returns **409** for an
illegal edge (vs 400 for a bad enum value). `createRun`/`requeueWorkflowRun` are
documented direct-write bypasses.

### The kill flow

The dashboard **Kill** button writes `runs.kill_requested_at`. The runner
notices two ways: **piggyback** — every `POST /api/runs/:id/output` response
includes `kill_requested` (≤ one ~750ms flush); and a **fallback poll** of
`GET /api/runs/:id/kill` every 10s when the CLI is silent. The runner sends
SIGTERM, waits a grace period, then SIGKILL, and saves the CLI session id to
`runs.session_id` so a comment can resume the run.

## Runner architecture

The runner is a **separate Node CLI**, not the Next.js process. launchd (macOS)
invokes it every 60s; the systemd variant loops with `sleep 60`.

```
launchd (com.harbour.agent-runner, StartInterval=60)
  -> node bin/harbour.mjs agent run
       -> bin/lib/runner.mjs : runAgents()
            for each runner in ~/.harbour/runners.json: poll /api/agents/:id/next -> spawn CLI
  (workflows: a separate launchd job runs `harbour workflow run`,
   reading ~/.harbour/workflow-runners.json, polling /api/workflows/next)
```

| File | Role |
|---|---|
| `bin/harbour.mjs` | CLI dispatcher (`setup`, `admin`, `agent {…}`, `workflow {…}`) |
| `bin/lib/runner.mjs` | polling loop, prompt assembly, kill plumbing, session save |
| `bin/lib/providers.mjs` | per-CLI provider: command building, JSONL parsing, SIGTERM/SIGKILL grace |
| `bin/lib/install.mjs` | launchd plist install/uninstall (agent + workflow) |
| `bin/lib/connect.mjs` | decode `harbour {agent,workflow} connect <blob>` → write config |
| `bin/lib/config.mjs` | read/write `runners.json` / `workflow-runners.json` / `sessions.json` |
| `bin/lib/bootstrap.mjs` | `harbour setup` / `harbour admin create` (argon2id, direct DB) |

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
are cached in `sessions.json` to resume killed/waiting runs in place. **Eager**
agents (`agents.eager`) loop within one
tick while outcomes stay clean (`done`/`waiting`/`skipped`), bailing on
`failed`/`killed`/empty/error, capped at 50 iterations
(`shouldContinueEagerLoop`).

**Env layering.** Before spawning, the runner strips Claude Code nesting guards,
then layers the job's decrypted env vars onto the process environment so the
agent's shell can expand `$VAR` natively. (Hardening the rest of this allowlist
is a [PRD](../prd.md) §6 requirement — H4.)

## Frontend

Two App Router route groups:

- **`src/app/(auth)/`** — `login/`, `set-password/`. Public; no shell.
- **`src/app/(app)/`** — the dashboard, wrapped in `AppShell`: `captain/`,
  `runs/` (root dashboard), `jobs/`, `agents/`, `docs/`, `databases/`,
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
4. `src/lib/db/runs.ts` — the polling ladder, claim guards, `updateRunStatus`
   transition map, and the kill flow.
5. `src/lib/db/jobs.ts` — schedule advance, job-creation transactions.
6. `src/app/api/agents/[id]/next/route.ts` — the server side of polling and the
   `api` block that travels with each payload.
7. `bin/lib/runner.mjs` + `bin/lib/providers.mjs` — the client side of polling,
   prompt assembly, kill, and per-CLI parsing.
8. `bin/lib/bootstrap.mjs` — first-run admin creation.
9. `docs/guide.md` / `docs/admin-guide.md` — wire contracts, live-served on `/api/guide`
   and `/api/admin-guide`.
10. `src/lib/schedule.ts` — interval / weekly parsing and timezone math.
