# API

The codebase-side route map: every route file, its HTTP method, the auth wrapper
(and minimum role), and a one-liner. **77 route files.**

The **on-the-wire contract** an agent reads at runtime — payload shapes, error
envelopes, status semantics — lives in two source files served live by the
running server:

- **[guide.md](../guide.md)** → `GET /api/guide`. Contract for **worker**
  agents (poll for runs).
- **[admin-guide.md](../admin-guide.md)** → `GET /api/admin-guide`. Contract
  for **management** agents (admin-key holders).

For the auth model behind the wrapper names below — identities, roles, scope
resolution — see [architecture.md](architecture.md#auth-model). In short:
`viewer < editor < instance_admin`; agents are scoped to their own project's org;
not-found resolves to **403** to avoid leaking existence across tenants.

Bearer tokens dispatch by prefix: `hbx_` is a per-run **exec token** (executor
identity, bound to one run — accepted by the run-lifecycle wrappers below),
`hbrn_` is a **runner token** (the claim endpoint only), and `hbr_` is an **agent
key or admin key**. `withAgentOrUser` accepts a user, a permanent agent key, or an
agent-run's exec token (the executor acts as the run's agent).

## Conventions

- Bodies are JSON except attachment uploads (`multipart/form-data`).
- Timestamps are epoch seconds; IDs are uuid except `run_output.id` /
  `captain_output.id` (auto-increment, used as SSE `?after=N` cursors).
- Errors are `{ "error": "<message>" }`. `401` unauthenticated, `403`
  forbidden/out-of-scope, `409` for conflicts — an illegal run-status edge,
  kill-while-not-running, or a create (`POST /api/orgs`, `/api/projects`,
  `/api/agents`) whose name slugifies to an existing sibling's slug (a name
  with no letters or numbers at all is a `400`).
- **Input validation.** Handlers parse the body with `readJson` and the
  `require*`/`optional*`/`assertOneOf` guards in `src/lib/http.ts`, which throw
  `HttpError`; the auth wrappers' `runHandler` renders those as `{ error }`.
  Net effect every mutation route inherits: a malformed/empty/non-object JSON
  body is a clean `400` (not a `500`), and a wrong-typed or unknown-enum field
  is a `400` rather than being silently stored. (`POST /api/tables/:id/rows`
  parses inline because the contract allows a top-level array.)
- **Scope** comes from the query string / cookies: org routes read `?orgId=` or
  the `harbour_org` cookie; project routes read `?projectId=`; `[id]` routes
  resolve the owning org from the resource.
- **Claim payload** (`POST /api/runner/claim`): `{ run: null }` or the kind-tagged
  `{ run, job, docs, tables, env, attachments, exec_token, api }`, plus `agent` and
  `workspace` (the org/project/agent slugs) on agent runs. `exec_token` is the
  freshly minted per-run `hbx_` credential and the `api` block is pre-resolved full
  URLs that authenticate with it. Full schema in
  [runner-guide.md](../runner-guide.md) (`GET /api/runner-guide`).
- **SSE**: `GET /api/runs/:id/output/stream` and
  `GET /api/captain/conversations/:id/stream` emit `event: output` (poll-backed),
  then `event: status` / `event: done` on terminal state.

## Public (bare handlers, no wrapper)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Verify password, set `harbour_session` cookie. Rate-limited: 5 failed attempts per email+IP per 15 minutes → `429` |
| POST | `/api/auth/logout` | Clear session cookie |
| POST | `/api/auth/set-password` | Redeem a single-use set-password token; sets password + session (min 12 chars). Rate-limited: 5 attempts per IP per hour → `429` |
| GET | `/api/auth/me` | Echo the current principal (resolves the caller itself) |
| GET | `/api/guide` | Serve [guide.md](../guide.md) (worker-agent / CLI contract) |
| GET | `/api/runner-guide` | Serve [runner-guide.md](../runner-guide.md) (the Runner Protocol) |

There is **no** signup route.

## Instance admin (`withInstanceAdmin`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/orgs` | Create an org |
| GET / POST | `/api/orgs/:id/members` | List / add org members (with role) |
| DELETE | `/api/orgs/:id/members/:userId` | Remove a member |
| GET / POST | `/api/users` | List / create users |
| PUT / DELETE | `/api/users/:id` | Update / delete a user |
| POST | `/api/users/:id/set-password-link` | Mint an invite / reset link |
| GET / POST | `/api/admin-api-keys` | List / create admin keys |
| DELETE | `/api/admin-api-keys/:id` | Revoke |
| GET / PUT | `/api/settings` | Read / bulk-set instance settings |
| GET | `/api/admin-guide` | Serve [admin-guide.md](../admin-guide.md) (`withAuthenticatedUser`) |

`PUT /api/orgs` (rename) is `withOrgAuth({editor})`.

## Orgs & projects

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET / POST | `/api/projects` | `withOrgAuth` (viewer / editor) | List / create projects in the org |
| GET | `/api/projects/:id` | `withResourceAuth` project (viewer) | Fetch |
| PUT / DELETE | `/api/projects/:id` | `withResourceAuth` project (editor) | Rename / archive (soft delete) |

## Agents

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET / POST | `/api/agents` | `withProjectAuth` (viewer / editor) | List / create in the project |
| GET | `/api/agents/:id` | `withResourceAuth` agent (viewer) | Fetch |
| PUT / DELETE | `/api/agents/:id` | `withResourceAuth` agent (editor) | Update / delete (+ runner config) |
| POST | `/api/agents/:id/rotate-key` | `withResourceAuth` agent (editor) | New API key |
| GET / POST | `/api/agents/:id/jobs` | `withResourceAuth` agent (viewer / editor) | List / create the agent's jobs |
| GET | `/api/agents/:id/runs` | `withResourceAuth` agent (viewer) | Run history |
| POST | `/api/agents/:id/tables` | `withAgentOrUser` (editor) | Convenience: create a table, optionally link to a job + seed rows |

## Jobs

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET / POST | `/api/jobs` | `withOrgAuth` (viewer / editor) | List jobs / create a **workflow** job; `?projectId=` |
| GET | `/api/jobs/:id` | `withResourceAuth` job (viewer) | Fetch |
| PUT / DELETE | `/api/jobs/:id` | `withResourceAuth` job (editor) | Update / delete |
| GET | `/api/jobs/:id/runs` | `withResourceAuth` job (viewer) | List the job's runs |
| POST | `/api/jobs/:id/trigger` | `withAgentOrUser` (editor) | Create an immediate run (optional extra instructions) |
| POST / DELETE | `/api/jobs/:id/docs[/:docId]` | `withResourceAuth` job (editor) | Link / unlink a doc |
| POST / DELETE | `/api/jobs/:id/env-vars[/:envVarId]` | `withResourceAuth` job (editor) | Link / unlink a secret |
| POST | `/api/jobs/:id/tables` | `withAgentOrUser` (editor) | Link a table |
| DELETE | `/api/jobs/:id/tables/:tableId` | `withResourceAuth` job (editor) | Unlink a table |

`/api/jobs` is dual-tier like the shared-context lists: `GET` with `?projectId=`
includes org-level jobs, and `POST` without a `projectId` (query or body)
creates an **org-level** workflow — agent jobs (`POST /api/agents/:id/jobs`)
are always project-level, and scope is fixed at creation. An org-level job may
link only org-level docs / env vars / tables; the link routes (and create /
update with `docIds` / `envVarIds`) return 400 otherwise.

A job's gates — `prerun` / `postrun` on an agent job, `command` on a workflow —
are each a **gate**: `{ runtime, content }`, where `runtime` is one of `bash`,
`python`, `node` (defaulting to `bash`) and `content` is the script body, stored
verbatim (never trimmed, so shebangs and leading blank lines survive). `POST
/api/agents/:id/jobs` takes `prerun?` / `postrun?` (and `postrunGates?`); `POST
/api/jobs` takes `command` (or `workflow` — same gate, required). On `PUT
/api/jobs/:id` each gate field is optional: omit it to leave the gate unchanged,
pass `null` to clear it, or pass an object to set it. A malformed gate (missing
or non-string `content`, an unknown `runtime`) is a 400. The gates are delivered
in the `/next` payload (`job.prerun` / `job.postrun` / `job.command` /
`job.scripts_dir`) and materialized to disk by the runner — see
[guide.md](../guide.md).

## Runs

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET | `/api/runs` | `withOrgAuth` (viewer) | Bundled `{scheduled, running, waiting, recent}`; `?filter=`, `?projectId=` (org-level runs included) |
| GET | `/api/runs/history` | `withOrgAuth` (viewer) | Paginated history |
| GET | `/api/runs/:id` | `withResourceAuth` run (viewer) | Run + activity + attachments |
| DELETE | `/api/runs/:id` | `withResourceAuth` run (editor) | Delete run + uploads |
| GET | `/api/runs/:id/activity` | `withResourceAuth` run (viewer) | Activity log |
| POST | `/api/runs/:id/activity` | `withRunExecutorOrUser` | Append; user comment on a terminal run → `pending`; workflow runs accept executor output only |
| GET | `/api/runs/:id/output` | `withResourceAuth` run (viewer) | Buffered output (`?after=`) |
| POST | `/api/runs/:id/output` | `withRunExecutorOrUser` | Executor streams output; response carries `kill_requested` |
| GET | `/api/runs/:id/output/stream` | `withResourceAuth` run (viewer) | SSE |
| GET | `/api/runs/:id/kill` | `withRunExecutorOrUser` | Kill-flag poll (runner fallback) |
| POST | `/api/runs/:id/kill` | `withResourceAuth` run (editor) | Request kill (409 if not running) |
| POST | `/api/runs/:id/retry` | `withResourceAuth` run (editor) | Retry terminal → `pending` (agent) / `scheduled` (workflow) |
| GET / PUT | `/api/runs/:id/status` | `withRunExecutorOrUser` | Read / set status (409 on illegal transition) |
| PUT | `/api/runs/:id/session` | `withRunExecutorOrUser` | Executor reports CLI session id + cwd |
| PUT | `/api/runs/:id/title` | `withRunExecutorOrUser` | Set the run title |

These lifecycle routes accept either the run's per-run **exec token** (`hbx_`,
minted at claim and bound to this run id) or a user meeting the stated role in the
run's org. The runner and the CLI it spawns authenticate every call here with the
exec token, never the runner token — see [architecture.md](architecture.md#auth-model).

### Run attachments

The top-level list/upload pair is `withRunExecutorOrUser` (exec token or user); the
per-attachment routes below stay `withAgentOrUser`.

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET / POST | `/api/runs/:id/attachments` | `withRunExecutorOrUser` | List / upload file (multipart) or embed (JSON) |
| DELETE | `/api/runs/:id/attachments/:aid` | `withAgentOrUser` | Delete |
| GET | `/api/runs/:id/attachments/:aid/file` | `withAgentOrUser` | Download bytes |
| GET / POST | `/api/runs/:id/attachments/:aid/processing` | `withAgentOrUser` | Video processing status / (re)queue |
| GET | `/api/runs/:id/attachments/:aid/screenshots` | `withAgentOrUser` | Paginated frames |
| GET | `/api/runs/:id/attachments/:aid/screenshots/:index/file` | `withAgentOrUser` | One JPEG |
| GET | `/api/runs/:id/attachments/:aid/transcript` | `withAgentOrUser` | Transcript / storyboard (`?format=plain`) |

## Shared context

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET | `/api/docs` | `withOrgAuth` (viewer) | List; `?projectId=` |
| POST | `/api/docs` | `withAgentOrUser` (editor) | Create (users **and** agents) |
| GET | `/api/docs/:id` | `withResourceAuth` doc (viewer) | Fetch latest content |
| PUT | `/api/docs/:id` | `withAgentOrUser` | Update (creates a revision; agents too) |
| DELETE | `/api/docs/:id` | `withResourceAuth` doc (editor) | Delete |
| GET | `/api/docs/:id/revisions` | `withResourceAuth` doc (viewer) | History |
| POST | `/api/docs/:id/pin` | `withResourceAuth` doc (editor) | Toggle pin |
| GET | `/api/tables` | `withOrgAuth` (viewer) | List; `?projectId=` |
| POST | `/api/tables` | `withAgentOrUser` (editor) | Create |
| GET | `/api/tables/:id` | `withResourceAuth` table (viewer) | Table + migrations + linked jobs |
| DELETE | `/api/tables/:id` | `withResourceAuth` table (editor) | Drop |
| POST | `/api/tables/:id/columns` | `withAgentOrUser` | Add a column (records a migration) |
| GET / POST | `/api/tables/:id/rows` | `withAgentOrUser` | Read (paginated) / insert |
| PUT / DELETE | `/api/tables/:id/rows/:rowId` | `withAgentOrUser` | Update / delete a row |
| POST | `/api/tables/:id/pin` | `withResourceAuth` table (editor) | Toggle pin |
| GET | `/api/env-vars` | `withOrgAuth` (viewer) | List secrets (no plaintext); `?projectId=` |
| POST | `/api/env-vars` | `withOrgAuth` (editor) | Create (encrypts) |
| GET | `/api/env-vars/:id` | `withResourceAuth` env_var (viewer) | Metadata (no plaintext) |
| PUT / DELETE | `/api/env-vars/:id` | `withResourceAuth` env_var (editor) | Rename/replace / delete |
| GET | `/api/env-vars/:id/value` | `withResourceAuth` env_var (editor) | Decrypted reveal |
| POST | `/api/env-vars/:id/pin` | `withResourceAuth` env_var (editor) | Toggle pin |

(The UI labels env vars **Secrets**; the route and table names stay `env-vars` /
`env_vars`.)

## Runner

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| POST | `/api/runner/claim` | `withRunnerAuth` | The one execution entry point: a runner POSTs `{ capabilities: { kinds, clis, labels } }` and gets back the next claimable run (kind-tagged, with its `exec_token` + pre-resolved `api` block) or `{ run: null }`. `?peek=true` reports availability/liveness without claiming |

This single endpoint replaces the old per-runner poll routes (`GET
/api/agents/:id/next`, `GET /api/workflows/next`) and the per-org workflow-runner
credential routes (`GET / POST /api/workflow-runners`), which are removed. Both
agent and workflow runs are claimed here; the server is the sole arbiter and
serializes claims in one SQLite transaction.

## Captain (all `withOrgAuth`)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/captain/conversations` | List / create a conversation |
| GET / PUT / DELETE | `/api/captain/conversations/:id` | Fetch / rename / delete |
| POST | `/api/captain/conversations/:id/messages` | Post a message — returns **202** `{messageId, userMessageId}` and spawns the CLI subprocess async; output arrives via the SSE stream |
| GET | `/api/captain/conversations/:id/status` | `{running, activeMessageId}` |
| POST | `/api/captain/conversations/:id/stop` | SIGTERM the active subprocess |
| GET | `/api/captain/conversations/:id/stream` | SSE output |

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
