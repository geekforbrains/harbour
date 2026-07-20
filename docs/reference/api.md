# API

The codebase-side route map: every route file, its HTTP methods, the auth
wrapper, and a one-liner. **70 route files.**

The **on-the-wire contract** an agent reads at runtime — payload shapes, error
envelopes, status semantics — lives in two source files served live by the
running server:

- **[guide.md](../guide.md)** → `GET /api/guide`. Contract for **worker**
  agents (poll for runs).
- **[management-guide.md](../management-guide.md)** → `GET /api/management-guide`.
  Contract for **management** agents (API-key holders).

For the auth model behind the wrapper names below — identities and the two
token-confinement invariants — see
[architecture.md](architecture.md#auth-model). In short: there are no roles and
no tenancy; any authenticated user may do everything, and `[id]` routes return
**404** for a missing resource.

Bearer tokens dispatch by prefix: `hbx_` is a per-run **exec token** (executor
identity, bound to one run — accepted by the run-lifecycle wrappers below),
`hbrn_` is a **runner token** (the claim endpoint only), and `hbr_` is an **API
key** (resolving to the creating user). `withAgentOrUser` accepts a user or an
agent-run's exec token (the executor acts as the run's agent).

## Conventions

- Bodies are JSON except attachment uploads (`multipart/form-data`).
- Timestamps are epoch seconds; IDs are uuid except `run_output.id`
  (auto-increment, used as an SSE `?after=N` cursor).
- Errors are `{ "error": "<message>" }`. `401` unauthenticated, `403` wrong
  identity type (or an exec token presented outside its run), `404` missing
  resource, `409` for conflicts — an illegal run-status edge,
  kill-while-not-running, or a create (`POST /api/projects`, `/api/agents`)
  whose name slugifies to an existing sibling's slug (a name with no letters
  or numbers at all is a `400`).
- **Input validation.** Handlers parse the body with `readJson` and the
  `require*`/`optional*`/`assertOneOf` guards in `src/lib/http.ts`, which throw
  `HttpError`; the auth wrappers' `runHandler` renders those as `{ error }`.
  Net effect every mutation route inherits: a malformed/empty/non-object JSON
  body is a clean `400` (not a `500`), and a wrong-typed or unknown-enum field
  is a `400` rather than being silently stored. (`POST /api/tables/:id/rows`
  parses inline because the contract allows a top-level array.)
- **Project scoping.** List routes take an optional `?projectId=`: omitted, the
  list spans **every** project (rows carry `project_name`); present, it narrows
  to that project. Create routes **require** a project, resolved as body
  `projectId` → `?projectId=` query → (for an agent executor) the agent's own
  project; missing → `400 {"error":"projectId is required"}`, unknown →
  `404 {"error":"Project not found"}`.
- **Claim payload** (`POST /api/runner/claim`): `{ run: null }` or the kind-tagged
  `{ run, job, docs, tables, env, attachments, exec_token, api }`, plus `agent` and
  `workspace` (the `{project, agent}` slugs) on agent runs. `exec_token` is the
  freshly minted per-run `hbx_` credential and the `api` block is pre-resolved full
  URLs that authenticate with it. Full schema in
  [runner-guide.md](../runner-guide.md) (`GET /api/runner-guide`).
- **SSE**: `GET /api/runs/:id/output/stream` emits `event: output` (poll-backed),
  then `event: status` / `event: done` on terminal state.

## Public (bare handlers, no wrapper)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Verify password, set `harbour_session` cookie. Rate-limited: 5 failed attempts per email+IP per 15 minutes → `429` |
| POST | `/api/auth/logout` | Clear session cookie |
| POST | `/api/auth/set-password` | Redeem a single-use set-password token; sets password + session (min 12 chars). Rate-limited: 5 attempts per IP per hour → `429` |
| GET | `/api/auth/me` | Identity echo: `{ type: "user", user }` for users, `{ type: "runner", runner }` / `{ type: "executor", run_id }` for tokens |
| GET | `/api/guide` | Serve [guide.md](../guide.md) (worker-agent / CLI contract) |
| GET | `/api/runner-guide` | Serve [runner-guide.md](../runner-guide.md) (the Runner Protocol) |

There is **no** signup route.

## Users, keys & settings (`withAuthenticatedUser`)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/users` | List users (each with a `pending` flag until its set-password link is consumed) / create (`{email, displayName?}`, no password yet) |
| PUT / DELETE | `/api/users/:id` | Rename (`{displayName}`) / delete — deleting the last remaining user is refused (`400 {"error":"Cannot delete the last user"}`) |
| POST | `/api/users/:id/set-password-link` | Mint an invite / reset link |
| GET / POST | `/api/api-keys` | List / create API keys (`hbr_` + 64 hex) |
| DELETE | `/api/api-keys/:id` | Revoke |
| GET / PUT | `/api/settings` | Read / bulk-set instance settings (sensitive values masked on read); holds the instance timezone |
| GET | `/api/management-guide` | Serve [management-guide.md](../management-guide.md) |

## Projects (`withAuthenticatedUser`)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/projects` | List all / create (`{name}`; slug collision → 409) |
| GET | `/api/projects/:id` | Fetch |
| PUT | `/api/projects/:id` | Rename (slug is immutable) |
| DELETE | `/api/projects/:id` | **Hard delete** — CASCADE wipes every agent, job, run, doc, secret, and table beneath it |

## Agents

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET / POST | `/api/agents` | `withAuthenticatedUser` | List (`?projectId=` optional, rows carry `project_name`) / create (project required; `cli` required) |
| GET | `/api/agents/:id` | `withAuthenticatedUser` | Fetch |
| PUT / DELETE | `/api/agents/:id` | `withAuthenticatedUser` | Update / delete |
| GET / POST | `/api/agents/:id/jobs` | `withAuthenticatedUser` | List / create the agent's jobs |
| GET | `/api/agents/:id/runs` | `withAuthenticatedUser` | Run history |
| POST | `/api/agents/:id/tables` | `withAgentOrUser` | Convenience: create a table, optionally link to a job + seed rows |

## Jobs

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET / POST | `/api/jobs` | `withAuthenticatedUser` | List jobs (`?projectId=` optional) / create a **workflow** job (project required) |
| GET | `/api/jobs/:id` | `withAuthenticatedUser` | Fetch |
| PUT / DELETE | `/api/jobs/:id` | `withAuthenticatedUser` | Update / delete |
| GET | `/api/jobs/:id/runs` | `withAuthenticatedUser` | List the job's runs |
| POST | `/api/jobs/:id/trigger` | `withAgentOrUser` | Create an immediate run (optional extra instructions) |
| POST / DELETE | `/api/jobs/:id/docs[/:docId]` | `withAuthenticatedUser` | Link / unlink a doc |
| POST / DELETE | `/api/jobs/:id/env-vars[/:envVarId]` | `withAuthenticatedUser` | Link / unlink a secret |
| POST | `/api/jobs/:id/tables` | `withAgentOrUser` | Link a table |
| DELETE | `/api/jobs/:id/tables/:tableId` | `withAuthenticatedUser` | Unlink a table |

Agent jobs are created via `POST /api/agents/:id/jobs`; `POST /api/jobs`
creates only deterministic workflow jobs (an `agentId` in the body is a 400
pointing at the agent route). Job↔resource links are **unrestricted across
projects** — the link inserts are `INSERT OR IGNORE`, so re-linking is a no-op.
The run bundle composes the job's own project's pinned resources first, then
the linked resources in link order (later wins on a payload name collision).

A job's gates — `prerun` / `postrun` on an agent job, `command` on a workflow —
are each a **gate**: `{ runtime, content }`, where `runtime` is one of `bash`,
`python`, `node` (defaulting to `bash`) and `content` is the script body, stored
verbatim (never trimmed, so shebangs and leading blank lines survive). `POST
/api/agents/:id/jobs` takes `prerun?` / `postrun?` (and `postrunGates?`); `POST
/api/jobs` takes `command` (or `workflow` — same gate, required). On `PUT
/api/jobs/:id` each gate field is optional: omit it to leave the gate unchanged,
pass `null` to clear it, or pass an object to set it. A malformed gate (missing
or non-string `content`, an unknown `runtime`) is a 400. The gates are delivered
in the `POST /api/runner/claim` payload (`job.prerun` / `job.postrun` /
`job.command` / `job.scripts_dir`) and materialized to disk by the runner — see
[guide.md](../guide.md).

## Runs

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET | `/api/runs` | `withAuthenticatedUser` | Bundled `{scheduled, running, waiting, recent}`; `?filter=waiting\|recent`, `?projectId=` |
| GET | `/api/runs/history` | `withAuthenticatedUser` | Paginated history (`?status=`, `?includeSkipped=`, `?agentId=`, `?jobId=`, `?projectId=`, `?from=`/`?to=`, `?sort=`, `?limit=`/`?offset=`) |
| GET | `/api/runs/health` | `withAuthenticatedUser` | Absent-runner surface: placements with queued runs no live runner is serving (drives the dashboard stall banner); `?projectId=` |
| GET | `/api/runs/:id` | `withAuthenticatedUser` | Run + activity + attachments (carries `project_name`) |
| DELETE | `/api/runs/:id` | `withAuthenticatedUser` | Delete run + uploads |
| GET | `/api/runs/:id/activity` | `withAuthenticatedUser` | Activity log |
| POST | `/api/runs/:id/activity` | `withRunExecutorOrUser` | Append; user comment on a terminal run → `pending`; workflow runs accept executor output only |
| GET | `/api/runs/:id/output` | `withAuthenticatedUser` | Buffered output (`?after=`) |
| POST | `/api/runs/:id/output` | `withRunExecutorOrUser` | Executor streams output; response carries `kill_requested` |
| GET | `/api/runs/:id/output/stream` | `withAuthenticatedUser` | SSE |
| GET | `/api/runs/:id/kill` | `withRunExecutorOrUser` | Kill-flag poll (runner fallback) |
| POST | `/api/runs/:id/kill` | `withAuthenticatedUser` | Request kill (409 if not running) |
| POST | `/api/runs/:id/retry` | `withAuthenticatedUser` | Retry terminal → `pending` (agent) / `scheduled` (workflow) |
| GET / PUT | `/api/runs/:id/status` | `withRunExecutorOrUser` | Read / set status (409 on illegal transition) |
| PUT | `/api/runs/:id/session` | `withRunExecutorOrUser` | Executor reports CLI session id + cwd |
| PUT | `/api/runs/:id/title` | `withRunExecutorOrUser` | Set the run title |

The `withRunExecutorOrUser` routes accept either the run's per-run **exec
token** (`hbx_`, minted at claim and bound to this run id — a token for another
run is rejected) or any authenticated user. The runner and the CLI it spawns
authenticate every call here with the exec token, never the runner token — see
[architecture.md](architecture.md#auth-model). Two of these routes are
executor-only despite the shared wrapper: `POST /api/runs/:id/output` and
`PUT /api/runs/:id/session` return **403** to user callers in-handler — users
never write run output or sessions.

### Run attachments

All attachment routes use `withRunExecutorOrUser` — the run's per-run **exec
token** (bound to this run id; an executor can't reach another run's
attachments) or any authenticated user.

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET / POST | `/api/runs/:id/attachments` | `withRunExecutorOrUser` | List / upload file (multipart) or embed (JSON) |
| DELETE | `/api/runs/:id/attachments/:aid` | `withRunExecutorOrUser` | Delete |
| GET | `/api/runs/:id/attachments/:aid/file` | `withRunExecutorOrUser` | Download bytes |
| GET / POST | `/api/runs/:id/attachments/:aid/processing` | `withRunExecutorOrUser` | Video processing status / (re)queue |
| GET | `/api/runs/:id/attachments/:aid/screenshots` | `withRunExecutorOrUser` | Paginated frames |
| GET | `/api/runs/:id/attachments/:aid/screenshots/:index/file` | `withRunExecutorOrUser` | One JPEG |
| GET | `/api/runs/:id/attachments/:aid/transcript` | `withRunExecutorOrUser` | Transcript / storyboard (`?format=plain`) |

## Shared context

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET | `/api/docs` | `withAuthenticatedUser` | List; `?projectId=` |
| POST | `/api/docs` | `withAgentOrUser` | Create (users **and** agents; agents default to their own project) |
| GET | `/api/docs/:id` | `withAuthenticatedUser` | Fetch latest content |
| PUT | `/api/docs/:id` | `withAgentOrUser` | Update (creates a revision; agents too) |
| DELETE | `/api/docs/:id` | `withAuthenticatedUser` | Delete |
| GET | `/api/docs/:id/revisions` | `withAuthenticatedUser` | History |
| POST | `/api/docs/:id/pin` | `withAuthenticatedUser` | Toggle pin |
| GET | `/api/tables` | `withAuthenticatedUser` | List; `?projectId=` |
| POST | `/api/tables` | `withAgentOrUser` | Create |
| GET | `/api/tables/:id` | `withAuthenticatedUser` | Table + migrations + linked jobs |
| DELETE | `/api/tables/:id` | `withAuthenticatedUser` | Drop |
| POST | `/api/tables/:id/columns` | `withAgentOrUser` | Add a column (records a migration) |
| GET / POST | `/api/tables/:id/rows` | `withAgentOrUser` | Read (paginated) / insert |
| PUT / DELETE | `/api/tables/:id/rows/:rowId` | `withAgentOrUser` | Update / delete a row |
| POST | `/api/tables/:id/pin` | `withAuthenticatedUser` | Toggle pin |
| GET | `/api/env-vars` | `withAuthenticatedUser` | List secrets (no plaintext); `?projectId=` |
| POST | `/api/env-vars` | `withAuthenticatedUser` | Create (encrypts) — **user-only**; agents cannot create secrets |
| GET | `/api/env-vars/:id` | `withAuthenticatedUser` | Metadata (no plaintext) |
| PUT / DELETE | `/api/env-vars/:id` | `withAuthenticatedUser` | Rename/replace / delete |
| GET | `/api/env-vars/:id/value` | `withAuthenticatedUser` | Decrypted reveal |
| POST | `/api/env-vars/:id/pin` | `withAuthenticatedUser` | Toggle pin |

(The UI labels env vars **Secrets**; the route and table names stay `env-vars` /
`env_vars`. An env-var name duplicated within a project is a 400:
`already exists in this project`.)

## Runner

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| POST | `/api/runner/claim` | `withRunnerAuth` | The one execution entry point: a runner POSTs `{ capabilities: { kinds, clis, labels } }` and gets back the next claimable run (kind-tagged, with its `exec_token` + pre-resolved `api` block) or `{ run: null }`. `?peek=true` reports availability/liveness without claiming |
| GET / POST | `/api/runners` | `withAuthenticatedUser` | List the execution pool (every runner + its in-flight slot count) / mint a **remote** runner credential (returns a `connect` blob to enroll on another host; optional `scope: {agentId}` restricts it to one agent's work) |
| DELETE | `/api/runners/:id` | `withAuthenticatedUser` | Revoke a runner (token 401s immediately on next claim; `runs.claimed_by` nulled by FK) |

Both agent and workflow runs are claimed at the single claim endpoint; the
server is the sole arbiter and serializes claims in one SQLite transaction. A
runner scoped to an agent (`scope.agentId`) claims only that agent's runs and
never workflows.

## System (`withAuthenticatedUser`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/settings/timezones` | Supported timezone list |
| GET | `/api/settings/video-processing/check` | Probe ffmpeg / whisper / provider availability |
| GET | `/api/system/cli-tools` | Detect installed CLI tools |
| GET | `/api/system/upload-config` | `{max_upload_mb, max_upload_bytes}` |

## Adding a route

New `route.ts` under `src/app/api/<path>/`; wrap it with the narrowest fitting
HOF from `src/lib/auth.ts`; add a row to the relevant table above. Never write an
inline auth check.
