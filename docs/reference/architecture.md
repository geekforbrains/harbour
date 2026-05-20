# Architecture

A 30-minute orientation for someone digging in. Not exhaustive — pointer-rich.

## Overview

Harbour is a **single Next.js process** plus a **single SQLite file**. There is no Redis, no message queue, no separate worker pool. Recurring jobs become rows in `runs` with `status='scheduled'`; an agent (or workflow runner) polls an HTTP endpoint to claim work. State changes happen inside SQLite transactions, so the run-claim path is atomic without external coordination.

Everything an installation needs lives under one directory — by default `~/.harbour/`:

| Path | Contents |
|---|---|
| `harbour.db` (+ `-wal`, `-shm`) | SQLite database (WAL mode) |
| `encryption.key` | 64-char hex key for env var AES-256-GCM |
| `uploads/runs/<runId>/` | Run attachment files |
| `runners.json` | Local runner config (agent → CLI tool mapping) |
| `sessions.json` | CLI session ID cache for run resume |
| `workflows/` | User-supplied scripts invoked by workflow jobs |
| `captain/` | Captain conversation workspace (default cwd) |
| `runner.log`, `runner.err.log` | launchd output for the agent runner |

Override roots via `HARBOUR_HOME`, `HARBOUR_DB_PATH`, `HARBOUR_UPLOADS_DIR`, `HARBOUR_ENCRYPTION_KEY`, `HARBOUR_MAX_UPLOAD_MB` (default 500). See `src/lib/paths.ts`.

## Tech stack

Versions pulled directly from `package.json` at v1.14.0:

| Layer | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) | 16.2.1 |
| UI runtime | React | 19.2.4 |
| Styling | Tailwind | ^4 (with `@tailwindcss/postcss`) |
| Components | shadcn/ui (built on `@base-ui/react`) | shadcn ^4.1.1 |
| DB driver | better-sqlite3 | ^12.8.0 |
| Auth hashing | bcryptjs | ^3.0.3 |
| JWT/JOSE | jose | ^6.2.2 |
| Client state | TanStack Query | ^5.95.2 |
| Markdown | react-markdown + remark-gfm + marked | ^10.1.0 / ^4.0.1 / ^17.0.5 |
| Multipart upload | busboy | ^1.6.0 |
| Tests | Vitest | ^4.1.2 |
| Browser tests | @playwright/test | ^1.58.2 |
| Linting | ESLint 9 + eslint-config-next | ^9 / 16.2.1 |
| TypeScript | typescript | ^5 |

The repo ships a tiny CLI: `npm run harbour -- ...` resolves to `bin/harbour.mjs` (77 lines), which dispatches to the runner library under `bin/lib/`.

## Auth model

Three principals authenticate against the API:

1. **User session** — login at `/login`, sets the `harbour_session` cookie (HttpOnly, SameSite=Lax, 30 days). Sessions live in the `sessions` table. Created at `src/app/api/auth/login/route.ts`.
2. **Agent API key** — bearer token in `Authorization: Bearer <key>`. Stored bcrypt-hashed in `agents.api_key_hash`. Each agent has exactly one key; rotated via `POST /api/agents/:id/rotate-key`.
3. **Admin API key** — bearer token, but resolves to a **user identity** (the creator's `user_id`). Stored hashed in `admin_api_keys`. Lets an external operator agent act as a user.

Every route is wrapped in one of two HOFs from `src/lib/auth.ts`:

| Wrapper | Accepts | Source |
|---|---|---|
| `withAuth(handler)` | user OR agent OR admin key | `src/lib/auth.ts` |
| `withUserAuth(handler)` | user OR admin key (not agent) | `src/lib/auth.ts` |

Inside a `withAuth` handler, one extra guard is used for finer-grained scope:

- **`requireAgentOwnership(auth, agentId)`** — when the auth principal is an agent, asserts it owns the resource (matches `agentId`). Returns 403 otherwise; users always pass through. `src/lib/auth.ts`.

There are **no** inline auth checks anywhere in `src/app/api/`; the wrappers are mandatory.

## Polling ladder

When a runner POSTs to `GET /api/agents/:id/next`, the server runs a priority ladder inside one transaction. The ladder is in `src/lib/db/runs.ts` (`getAgentNextRun`). Steps fall through if they don't match.

```
Step 0  Fail any 'running' runs that exceeded job.timeout_minutes (failStaleRuns)
Step 1  Agent already has a 'running' run? -> return null (busy)
Step 2  'pending' run for this agent? -> flip to 'running', return it
Step 3  'scheduled' run with scheduled_for <= now? -> claim, return it
Step 4  Recurring schedule-triggered job past next_run_at? -> create run, advance schedule
```

**Atomicity.** The whole sequence is a `db.transaction(() => ...)`.

**Workflow-only counterpart.** `getNextWorkflowRun()` in `src/lib/db/runs.ts` runs the same shape for agentless `workflow_only=1` jobs (no agent_id), exposed at `GET /api/workflows/next`.

## Run lifecycle

```
                                +-- failed (terminal)
                                |
                                +-- skipped (terminal; workflow exit 77)
                                |
                                +-- killed (terminal; SIGTERM, resumable via comment)
scheduled --> running ----------+
   ^             |              |
   |             +-- waiting -- pending --> running --> ...
   |                                ^
   +-- (never reached on terminal)  +-- comment from user on
                                        waiting/done/failed/killed
```

- **`scheduled`** — created by `triggerJobRun` (one-off) with a future `scheduled_for`, or by a job's recurring schedule.
- **`running`** — the runner has claimed it. Sets `claimed_at`. While in `running`, the job's other queued runs sit behind it.
- **`waiting`** — the agent paused, asked for human input.
- **`pending`** — a human responded (commented or retried). Step 2 of the polling ladder picks it up next.
- **`done` / `failed` / `skipped` / `killed`** — terminal. Sets `completed_at`. `done`/`failed`/`skipped` advance the job's `next_run_at`; `killed` does **not** (the user stopped it intentionally).

`PUT /api/runs/:id/status` (in `src/app/api/runs/[id]/status/route.ts`) validates the body against a fixed enum (`running`, `waiting`, `pending`, `done`, `failed`, `skipped`, `killed`); 400 for unknown values. The diagram above is enforced by callers, not a transition graph.

### The kill flow

The dashboard's **Kill** button writes `runs.kill_requested_at = unixepoch()`. The runner notices this **two ways**:

1. **Piggyback** — the runner POSTs streaming output to `/api/runs/:id/output` every ~750ms while the CLI is talking. Each response includes `kill_requested: <bool>`. When true, the runner aborts the child process. Latency: ≤ one flush cycle.
2. **Fallback poll** — if the CLI is silent (long thinking stretch, no output), the runner GETs `/api/runs/:id/kill` every 10s as a safety net.

The handlers live at `src/app/api/runs/[id]/output/route.ts` (piggyback) and `src/app/api/runs/[id]/kill/route.ts` (poll). The runner code is in `bin/lib/runner.mjs`. After SIGTERM, the runner saves the CLI session ID to `sessions.json` so a comment on the killed run can resume it from where it left off.

## Runner architecture

The runner is a **separate Node CLI** invoked by launchd every 60 seconds (macOS only at the moment). It is not run by the Next.js process.

```
launchd (com.harbour.agent-runner, StartInterval=60)
    |
    +--> node bin/harbour.mjs agent run
              |
              +--> bin/lib/runner.mjs : runAgents()
                      for each runner in ~/.harbour/runners.json:
                        loop (eager agents) or once:
                          GET /api/agents/:id/next      --> spawn CLI
                      if any runner.url is local:
                        GET /api/workflows/next         --> spawn shell
```

Per-runner the inner step is single-shot by default. Agents flagged `eager` (column on `agents`, surfaced as `agent.eager` on the `/next` payload) keep polling and processing as long as the queue returns clean outcomes (`done`/`waiting`/`skipped`). A failed or killed run, an empty `/next`, or the 50-iteration safety cap exits the loop. Logic lives in `runSingleAgent` and `shouldContinueEagerLoop` (`bin/lib/runner.mjs`).

Key files:

| File | Role |
|---|---|
| `bin/harbour.mjs` | CLI dispatcher: `start | dev | agent {list,run,connect,install,uninstall}` |
| `bin/lib/runner.mjs` | Polling loop, prompt assembly, kill plumbing, session save (809 lines) |
| `bin/lib/providers.mjs` | Per-CLI provider (claude / codex / gemini) — command building, JSONL parsing, kill-grace SIGTERM/SIGKILL (519 lines) |
| `bin/lib/install.mjs` | launchd plist install/uninstall |
| `bin/lib/connect.mjs` | Decode the `harbour agent connect <blob>` and write a runner config |
| `bin/lib/config.mjs` | Read/write `~/.harbour/runners.json` and `~/.harbour/sessions.json` |

The runner streams CLI output to the server in batches (750 ms flush). All three providers emit normalized event types: `text_delta`, `tool_start`, `tool_end`, `thinking`, `info`, `error`, `result`. Frontend consumes these via SSE at `/api/runs/:id/output/stream`.

Workflow-only jobs are handled in the same poll cycle (`runAgentlessWorkflows`); only the runner whose `url` resolves to `localhost`/`127.0.0.1`/`::1`/`0.0.0.0` picks those up — see `isLocalUrl` and `runAgents` in `bin/lib/runner.mjs` (around lines 775-808). Remote runners deliberately skip the agentless workflow queue because the workflow scripts live on the harbour host.

## Frontend layout

The App Router has two route groups:

- **`src/app/(auth)/`** — `login/`, `signup/`. Public routes; no shell.
- **`src/app/(app)/`** — everything inside the dashboard. Wrapped in `AppShell`.
  - `agents/`, `captain/`, `databases/`, `docs/`, `env-vars/`, `jobs/`, `runs/`, `settings/`, `users/`
  - `page.tsx` — root dashboard (today's runs)
  - `layout.tsx` — `<AppShell>` wrapper

`AppShell` (`src/components/app/app-shell.tsx`) handles auth check (calls `/api/auth/me`, redirects to `/login` on 401), project state (localStorage `harbour_active_project`), sidebar/mobile navigation, the theme toggle, and a 5s waiting-runs poll for the sidebar badge. The document-level theme class is bootstrapped in `src/app/layout.tsx` from the same `harbour_theme` localStorage key. Descendants read `{ user, waitingCount, timezone, projects, activeProjectId, setActiveProjectId }` via `useApp()`.

### React Query refetch policies

The `QueryClient` defaults at `src/components/providers/query-provider.tsx`:

```
staleTime: 2000
refetchOnWindowFocus: true
```

Per-query overrides are common throughout the app:

| Surface | `refetchInterval` | Notes |
|---|---|---|
| Sidebar projects (`AppShell`) | 10 s | `app-shell.tsx` |
| Most list pages (runs, jobs, agents, docs) | 5 s | quick feedback during runs |
| Lookup queries (e.g. CLI tools, doc list in dialogs) | none, `staleTime: 60_000` | rarely change |

Detail pages (run, agent, doc, database row table) typically poll at 5 s; SSE streams (run output, captain output) replace the poll once an agent is actually streaming.

## File layout

```
src/
  app/
    (auth)/             user-facing login/signup
    (app)/              dashboard pages (one folder per nav item)
    api/                67 route.ts files (100 HTTP method handlers)
    layout.tsx          root layout, theme bootstrap
  components/
    app/                AppShell, dialogs, run-status
    ui/                 shadcn primitives (button, dialog, etc.)
    providers/          QueryProvider
  lib/
    db/                 schema + per-table query modules
    captain/            spawn/stop a CLI subprocess for in-browser chat
    auth.ts             withAuth, withUserAuth, requireAgentOwnership
    encryption.ts       AES-256-GCM for env vars
    schedule.ts         schedule parsing + tz-aware next_run_at math
    paths.ts            HARBOUR_HOME-rooted file paths
    runners.ts          runners.json read/write
    cli-config.ts       per-CLI model and thinking options
    upload.ts           busboy multipart receive
    video-processing.ts ffmpeg + whisper screenshots/transcripts
    request-url.ts      reverse-proxy-aware base URL resolution
bin/
  harbour.mjs           CLI entry
  lib/                  runner, providers, install, config, connect (5 files, ~1573 lines)
docs/
  concepts/             mental-model writeups
  guides/               step-by-step setup
  reference/            this folder (architecture, schema, API)
GUIDE.md                served at GET /api/guide; agent wire contract
ADMIN_GUIDE.md          served at GET /api/admin-guide; admin-key wire contract
CHANGELOG.md            release history
terraform/              DigitalOcean droplet config
```

## Source-of-truth pointers

A new contributor should read these in order:

1. `src/lib/db/schema.ts` — every table, every migration. The file evolves; all schema lives here.
2. `src/lib/auth.ts` — auth model.
3. `src/lib/db/runs.ts` — the polling ladder, the kill request flow, and run lifecycle in one file.
4. `src/lib/db/jobs.ts` — schedule advance, job creation transactions.
5. `src/app/api/agents/[id]/next/route.ts` — the server side of agent polling, including the `api` section that travels with each payload.
6. `bin/lib/runner.mjs` — the client side of polling, prompt assembly, and the kill flow.
7. `bin/lib/providers.mjs` — Claude/Codex/Gemini command building and stream parsing.
8. `src/components/app/app-shell.tsx` — frontend chrome and project filtering.
9. `GUIDE.md` and `ADMIN_GUIDE.md` — wire contracts; live-served on `/api/guide` and `/api/admin-guide`.
10. `src/lib/schedule.ts` — interval / weekly schedule parsing and timezone math.
