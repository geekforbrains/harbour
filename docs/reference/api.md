# API

The codebase-side route map: every route file, its HTTP method, the auth wrapper
(and minimum role), and a one-liner. **77 route files.**

The **on-the-wire contract** an agent reads at runtime — payload shapes, error
envelopes, status semantics — lives in two source files served live by the
running server:

- **[GUIDE.md](../../GUIDE.md)** → `GET /api/guide`. Contract for **worker**
  agents (poll for runs).
- **[ADMIN_GUIDE.md](../../ADMIN_GUIDE.md)** → `GET /api/admin-guide`. Contract
  for **management** agents (admin-key holders).

For the auth model behind the wrapper names below — identities, roles, scope
resolution — see [architecture.md](architecture.md#auth-model). In short:
`viewer < editor < instance_admin`; agents are scoped to their own project's org;
not-found resolves to **403** to avoid leaking existence across tenants.

## Conventions

- Bodies are JSON except attachment uploads (`multipart/form-data`).
- Timestamps are epoch seconds; IDs are uuid except `run_output.id` /
  `captain_output.id` (auto-increment, used as SSE `?after=N` cursors).
- Errors are `{ "error": "<message>" }`. `401` unauthenticated, `403`
  forbidden/out-of-scope, `409` for transition conflicts (illegal run-status
  edge, kill-while-not-running).
- **Scope** comes from the query string / cookies: org routes read `?orgId=` or
  the `harbour_org` cookie; project routes read `?projectId=`; `[id]` routes
  resolve the owning org from the resource.
- **`/next` payload** (`GET /api/agents/:id/next` and `/api/workflows/next`):
  `null` or `{ run, job, docs, data, env, attachments, api }`. The `api` block is
  pre-resolved full URLs. Full schema in [GUIDE.md](../../GUIDE.md).
- **SSE**: `GET /api/runs/:id/output/stream` and
  `GET /api/captain/conversations/:id/stream` emit `event: output` (poll-backed),
  then `event: status` / `event: done` on terminal state.

## Public (bare handlers, no wrapper)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Verify password, set `harbour_session` cookie |
| POST | `/api/auth/logout` | Clear session cookie |
| POST | `/api/auth/set-password` | Redeem a single-use set-password token; sets password + session |
| GET | `/api/auth/me` | Echo the current principal (resolves the caller itself) |
| GET | `/api/guide` | Serve [GUIDE.md](../../GUIDE.md) |

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
| GET | `/api/admin-guide` | Serve [ADMIN_GUIDE.md](../../ADMIN_GUIDE.md) (`withAuthenticatedUser`) |

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
| POST | `/api/agents/:id/data` | `withAgentOrUser` (editor) | Convenience: create a database, optionally link to a job + seed rows |
| GET | `/api/agents/:id/next` | `withAgentAuth` + `requireAgentSelf` | **Poll** for work (`?peek=true`) |

## Jobs

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET / POST | `/api/jobs` | `withProjectAuth` (viewer / editor) | List jobs / create a **workflow** job |
| GET | `/api/jobs/:id` | `withResourceAuth` job (viewer) | Fetch |
| PUT / DELETE | `/api/jobs/:id` | `withResourceAuth` job (editor) | Update / delete |
| GET | `/api/jobs/:id/runs` | `withResourceAuth` job (viewer) | List the job's runs |
| POST | `/api/jobs/:id/trigger` | `withAgentOrUser` (editor) | Create an immediate run (optional extra instructions) |
| POST / DELETE | `/api/jobs/:id/docs[/:docId]` | `withResourceAuth` job (editor) | Link / unlink a doc |
| POST / DELETE | `/api/jobs/:id/env-vars[/:envVarId]` | `withResourceAuth` job (editor) | Link / unlink a secret |
| POST | `/api/jobs/:id/data` | `withAgentOrUser` (editor) | Link a database |
| DELETE | `/api/jobs/:id/data/:dataId` | `withResourceAuth` job (editor) | Unlink a database |

## Runs

| Method | Path | Wrapper (role) | Purpose |
|---|---|---|---|
| GET | `/api/runs` | `withOrgAuth` (viewer) | Bundled `{scheduled, running, waiting, recent}`; `?filter=`, `?projectId=` |
| GET | `/api/runs/history` | `withOrgAuth` (viewer) | Paginated history |
| GET | `/api/runs/:id` | `withResourceAuth` run (viewer) | Run + activity + attachments |
| DELETE | `/api/runs/:id` | `withResourceAuth` run (editor) | Delete run + uploads |
| GET | `/api/runs/:id/activity` | `withResourceAuth` run (viewer) | Activity log |
| POST | `/api/runs/:id/activity` | `withAgentOrUser` | Append; user comment on a terminal run → `pending`; workflow runs accept runner output only |
| GET | `/api/runs/:id/output` | `withResourceAuth` run (viewer) | Buffered output (`?after=`) |
| POST | `/api/runs/:id/output` | `withAgentOrUser` | Runner streams output; response carries `kill_requested` |
| GET | `/api/runs/:id/output/stream` | `withResourceAuth` run (viewer) | SSE |
| GET | `/api/runs/:id/kill` | `withAgentOrUser` | Kill-flag poll (runner fallback) |
| POST | `/api/runs/:id/kill` | `withResourceAuth` run (editor) | Request kill (409 if not running) |
| POST | `/api/runs/:id/retry` | `withAgentOrUser` | Retry terminal → `pending` (agent) / `scheduled` (workflow) |
| GET / PUT | `/api/runs/:id/status` | `withAgentOrUser` | Read / set status (409 on illegal transition) |
| PUT | `/api/runs/:id/session` | `withAgentOrUser` | Runner reports CLI session id + cwd |
| PUT | `/api/runs/:id/title` | `withAgentOrUser` | Set the run title |

### Run attachments (all `withAgentOrUser`)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/runs/:id/attachments` | List / upload file (multipart) or embed (JSON) |
| DELETE | `/api/runs/:id/attachments/:aid` | Delete |
| GET | `/api/runs/:id/attachments/:aid/file` | Download bytes |
| GET / POST | `/api/runs/:id/attachments/:aid/processing` | Video processing status / (re)queue |
| GET | `/api/runs/:id/attachments/:aid/screenshots` | Paginated frames |
| GET | `/api/runs/:id/attachments/:aid/screenshots/:index/file` | One JPEG |
| GET | `/api/runs/:id/attachments/:aid/transcript` | Transcript / storyboard (`?format=plain`) |

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
| GET | `/api/databases` | `withOrgAuth` (viewer) | List; `?projectId=` |
| POST | `/api/databases` | `withAgentOrUser` (editor) | Create |
| GET | `/api/databases/:id` | `withResourceAuth` database (viewer) | DB + migrations + linked jobs |
| DELETE | `/api/databases/:id` | `withResourceAuth` database (editor) | Drop |
| POST | `/api/databases/:id/columns` | `withAgentOrUser` | Add a column (records a migration) |
| GET / POST | `/api/databases/:id/rows` | `withAgentOrUser` | Read (paginated) / insert |
| PUT / DELETE | `/api/databases/:id/rows/:rowId` | `withAgentOrUser` | Update / delete a row |
| GET | `/api/env-vars` | `withOrgAuth` (viewer) | List secrets (no plaintext); `?projectId=` |
| POST | `/api/env-vars` | `withOrgAuth` (editor) | Create (encrypts) |
| GET | `/api/env-vars/:id` | `withResourceAuth` env_var (viewer) | Metadata (no plaintext) |
| PUT / DELETE | `/api/env-vars/:id` | `withResourceAuth` env_var (editor) | Rename/replace / delete |
| GET | `/api/env-vars/:id/value` | `withResourceAuth` env_var (editor) | Decrypted reveal |
| POST | `/api/env-vars/:id/pin` | `withResourceAuth` env_var (editor) | Toggle pin |

(The UI labels env vars **Secrets**; the route and table names stay `env-vars` /
`env_vars`.)

## Workflows

| Method | Path | Wrapper | Purpose |
|---|---|---|---|
| GET | `/api/workflows/next` | `withWorkflowRunnerAuth` | Poll for a workflow run (`?peek=true`) |
| GET / POST | `/api/workflow-runners` | `withOrgAuth` | List / create workflow-runner credentials |

## Captain (all `withOrgAuth`)

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/captain/conversations` | List / create a conversation |
| GET / PUT / DELETE | `/api/captain/conversations/:id` | Fetch / rename / delete |
| POST | `/api/captain/conversations/:id/messages` | Post a message; spawns the CLI subprocess |
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
