# Changelog

## Unreleased

### Breaking: orgs are gone — Harbour is flat

- **Orgs, memberships, roles, and the instance-admin flag are removed.** The
  hierarchy is now instance → projects → agents & jobs → runs, and every
  authenticated user can do everything. Projects organize work — slug unique
  instance-wide — and are no longer a tenancy boundary: lists span all projects
  by default (filter with `?projectId=`), and a job may link docs, secrets, and
  tables from any project. Pinning now auto-injects a resource into every run
  of every job in its own project.
- **Project delete is a hard delete** — no archive state; the cascade takes the
  project's agents, jobs, runs, docs, secrets, and tables with it.
- **Renames.** Admin API keys are now just **API keys** (`/api/api-keys`,
  `hbr_` prefix) and the admin guide is the **management guide**, served at
  `/api/management-guide`. The CLI's `harbour admin create` is
  `harbour user create` (env var `HARBOUR_USER_PASSWORD`); the `harbour
  migrate` command is removed. Runner scope drops `orgId` (only `agentId`
  remains). Workspace and script paths lose the org segment:
  `workspaces/<project>/<agent>` and `workflows/<project>[/<agent>]/<job-leaf>`.
- **Migration: none.** Harbour has no schema migrations — a fresh database is
  the only path across this change.

### Breaking: agents no longer bypass CLI permissions by default

- **Every agent now has a Permissions setting, and the default inverts the old
  always-bypass behavior.** **Enforced** (the new default) requires a policy
  file in the agent's workspace, written in the CLI's own native format; when
  the file is missing or invalid, the run fails closed with an actionable
  reason instead of running without limits. **Unrestricted** is a per-agent
  dashboard toggle that deliberately restores the old bypass flags
  (`--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox`) and shows a badge on the
  agent. Harbour validates the policy file and points the CLI at it but never
  authors its content — see the new
  [agent permissions guide](docs/guides/agent-permissions.md).
- **Claude Code policy: `<workspace>/.claude/settings.json`** — the CLI's own
  settings format (`permissions` rules, `defaultMode`, hooks, and the OS
  sandbox block). Passed as `--settings <file> --permission-mode <mode>
  --setting-sources project`; `--settings` rather than cwd discovery because
  project-scope settings silently ignore the sandbox keys that do the
  containing. `defaultMode` defaults to `dontAsk` and may not be
  `bypassPermissions` (bypassing is the dashboard toggle's job). The policy
  must allow the run protocol's `curl` calls (e.g. `Bash(curl *)`) or every
  run ends `failed`; Claude's "Ignoring permissions" stderr warnings are
  surfaced as run activity.
- **Codex policy: `<workspace>/.codex/config.toml`** — the CLI's own config
  format, with `sandbox_mode` set to `workspace-write` (`danger-full-access`
  is refused; use the dashboard toggle instead). Passed as
  `--skip-git-repo-check -s <mode> -c approval_policy=never`. Optional
  `.codex/rules/*.rules` execpolicy files add a command deny-list on top,
  validated up front with `codex execpolicy check`. The OS sandbox is the
  boundary — rules are a deny-list only, and unmatched commands run.
- **Codex policies must enable network access** with
  `[sandbox_workspace_write]` `network_access = true`. Codex's sandbox
  otherwise blocks every connection — loopback included — and the run
  protocol is loopback `curl` to the Harbour API, so such an agent could do
  work but never report a title, activity, or final status, and every run
  would end `failed` at the finalize backstop. Harbour refuses the policy up
  front instead; `read-only` is refused for the same reason.
- **Workspace trust is recorded automatically for both CLIs** before an
  enforced run spawns — Claude via `hasTrustDialogAccepted` in
  `~/.claude.json`, Codex via a `[projects."<dir>"]` entry in
  `$CODEX_HOME/config.toml` — because each CLI silently ignores a workspace
  policy in a directory it does not trust.
- **New CLI command: `harbour policy check [--agent <slug>]`** reads the
  agents table straight from the database (read-only, no server needed) and
  resolves every agent's policy with the same code the runner uses — one line
  per agent plus a summary, exit 1 when any enforced agent would be refused.
  Usable as a pre-deploy gate when upgrading.
- **Migration.** The orgs removal above already makes a fresh database the only
  supported path across this release, which covers this change too — a new DB
  gets the column from the schema. If you are instead carrying data forward by
  hand, add the column yourself or the server refuses to boot with a
  schema-drift error: `ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL
  DEFAULT 'enforced';`.
- **Every existing agent becomes Enforced**, however you arrive — that is the
  point of the change. Before its next run each agent needs a policy file in
  its workspace or a deliberate flip to Unrestricted in the dashboard; a run
  that finds neither fails closed with the reason in its activity. Run
  `harbour policy check` to see where every agent stands.

### Runs

- The dashboard's Recent feed shows individual runs again — the v2.1.0
  collapsed summary rows are gone. Skipped runs no longer appear in the feed
  (they remain reachable via the All Runs "Skipped" filter); a job shows at
  most a few of its latest successes (the new "Successes Per Job" setting,
  `recent_runs_per_job`, default 3) so a frequently-firing job can't bury
  other activity; failed and killed runs always appear individually. The
  "Collapse repeated successes" setting (`recent_collapse_success`) is
  removed.

### Agents

- **Codex model dropdown updated to the 5.6 lineup:** `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`. Removed `gpt-5.5` and `gpt-5.4`. Reasoning
  levels gain `max` (Codex now accepts the same `low`/`medium`/`high`/`xhigh`/
  `max` ladder as Claude).

### Install and operation

- **New production installs default to `127.0.0.1:4272`.** `npm start` and
  `harbour start` now share that explicit loopback default with the bundled
  runner; use `HARBOUR_PORT` during setup for a coordinated custom install, or
  use server-only `PORT`/CLI `--port` with `HARBOUR_URL` or
  `~/.harbour/runner.url` configured separately. Bare development
  starts consistently use port 3001. Page metadata uses the same local default
  unless `HARBOUR_PUBLIC_URL` is set at build time. Existing service
  definitions are not rewritten; when retaining port 3000, explicitly keep
  the server `PORT` and runner `HARBOUR_URL` aligned.
- **Setup is platform-safe.** macOS runner installation persists its
  non-secret configuration and uses modern launchd commands. Linux setup no
  longer attempts to install a launchd service and points operators to the
  documented systemd units instead. Both platforms now use the same supported
  `harbour start` production path rather than mixing `next start` with a
  standalone-output build.

### Removed

- **OpenCode and LLM connections are removed** — the provider surface is back to
  Claude Code and Codex only while the agent model is refined. Gone: the
  `opencode` CLI option, the **LLM Connections** dashboard page and nav entry,
  the `/api/llm-connections` routes, the `llm_connections` /
  `llm_connection_secrets` / `agent_llm_connections` tables, the claim payload's
  `agent.provider` and runner-private `runtime.llm.api_key` blocks, and the
  runner's OpenCode config generation, env isolation, and session fingerprints.
  A Secret is no longer reservable as a provider credential, so secret deletes
  no longer 409 and no Secret is withheld from job `env`. Output redaction and
  the cross-CLI session-resume guard are kept. On a fresh database the three
  tables are simply never created; existing databases keep them unused
  (harmless — nothing reads them). The work is parked on the
  `feat/opencode-connections` branch.
- **Gemini CLI is no longer an agent provider.** New and updated agents accept
  only `claude` or `codex`; the dashboard no longer detects or offers Gemini,
  and the bundled runner no longer advertises, launches, resumes, or parses it.
  Existing Gemini-backed agent rows are not migrated or supported.
- **Captain, the in-browser CLI console, is removed** — the `/captain` dashboard
  page and message UI, the `/api/captain` conversation routes, the server-side
  process manager/providers/workspace libs, the Captain settings panel and nav
  entry, and the `captain_*` tables. Captain launched an unsandboxed host CLI on
  behalf of any org editor, which fits poorly with Harbour's least-privilege
  posture; agent jobs, workflows, and the admin API cover its real uses. On a
  fresh database the `captain_*` tables are simply never created; existing
  databases keep the now-unused tables (harmless — nothing reads them).

### Docs

- Documented the one-time `npx playwright install chromium` step the local e2e
  suite needs (version-pinned bundled Chromium, not system Chrome).

## v2.1.0 — 2026-06-24

### Runs

- The dashboard's Recent feed now folds a job's repeated runs into a single
  summary row, so one frequently-firing job no longer buries other recent
  activity. Successful (`done`) runs collapse per job when the new "Collapse
  repeated successes" setting is on (the default); skipped runs always collapse
  and are now shown in this view (they were previously hidden); failed and
  killed runs are never collapsed and always appear individually. A collapsed
  row shows how many runs it stands for, links to the most recent run in the
  group, and the feed reaches further back the more it folds.
- Added a "Collapse repeated successes" toggle in Settings (instance-wide, on by
  default) controlling the `done`-run folding above.

## v2.0.1 — 2026-06-23

### Runner

- Fixed a scheduler/claim lock bug where an agent run paused in `waiting` for
  human review still counted as in flight. `waiting` runs are now treated as
  idle, so the agent's other jobs can continue while the paused run waits for a
  reply. Active execution still serializes per agent: `running` and `pending`
  runs hold the lock.
- Matched workflow-job claim guards and runner pool counts to the same rule:
  `waiting` is not an execution slot, while `scheduled`, `running`, and
  `pending` still prevent duplicate workflow materialization where appropriate.

### Tests and docs

- Added regression coverage for agent and workflow claim behavior around
  `waiting` runs.
- Updated the runner, architecture, agent, jobs/runs, PRD, and database-schema
  docs to state that `waiting` is idle rather than in flight.

## v2.0.0 — 2026-06-23

**Official v2 release.** v1 is now sunset. Harbour v2 is the supported line
going forward: a multi-tenant control plane organized around instance admins,
orgs, projects, shared context, remote runners, workflows, and the unified
runner protocol. Existing v1 installs should move to a fresh v2 install and use
`harbour migrate` to translate their data into the new schema. (The migrate
command and its guide were removed later, in the flatten above.)

### v2 foundation

- v2 replaces the single-tenant v1 data model with org/project scoping across
  agents, jobs, runs, docs, secrets, and tables. API routes now authorize through
  the v2 user/project wrappers, and first-run setup is a shell-admin flow instead
  of unauthenticated web signup.
- Shared context is now first-class at org and project scope, with docs, secrets,
  and tables composed into each claimed run. Job links and pinning rules are
  deterministic, with project-level context taking precedence over org defaults.
- The runner protocol is kind-tagged and centered on `POST /api/runner/claim`,
  so local and remote runners use the same claim path for agent runs and
  workflow runs.

### Migration

- Added `harbour migrate`, which reads a v1 Harbour home and translates agents,
  jobs, runs, docs, secrets, and tables into a v2 install. The migration keeps v1
  untouched and writes into the new v2 schema.
- Added a v1 migration guide covering fresh v2 setup, dry-run review, migrated
  data scope, and post-migration checks.

### Runners and workflows

- Remote runner setup now mints a `harbour agent connect <blob>` command, making
  it easier to move agent execution to another machine without hand-copying
  runner config.
- A single runner can advertise capabilities and serve many agents. The docs now
  frame remote runners protocol-first and clarify PATH, CLI detection, labels,
  and remote-workflow behavior.
- Workflow-only jobs, workflow gates, live runner updates, kill handling, and
  schedule advancement all land in the v2 line.

### Dashboard and docs

- The dashboard ships the v2 design system and React Query data layer, including
  org/project switching, instance-admin user management, shared-context screens,
  workflow views, and updated remote-runner flows.
- README screenshots and the documentation tree were refreshed for v2. Release
  docs now cover the dev-to-main merge, GitHub Release creation, and Node 24 CI
  alignment.

### Fixes since beta

- Agent work prompts now surface linked table context.
- Unknown table-row `orderBy` values return 400 instead of 500.
- Same-second doc revision lookups now use a rowid tiebreaker.
- Project delete copy, Captain workspace defaults, status colors, scheduler
  docs, schema docs, and release/validation drift were corrected.

## v2.0.0-beta.1 — 2026-06-09

**Beta — not an official release yet.** The first public cut of the v2 rebuild. v2 is a clean break: the schema is rebuilt around multi-tenancy and there is **no v1 → v2 migration**, so v2 starts from a fresh database. First-run setup moves to the shell (`harbour setup`); web signup is gone.

### Multi-tenancy (orgs & projects)

- Harbour is now multi-tenant. An **instance admin** owns the install; work is organized into **orgs → projects**; and every agent, job, doc, secret, and database lives inside a project. Resources never cross org lines.
- New v2 schema and access layer enforce the org → project hierarchy, and every API route was migrated to org/project authorization with role checks (`withUserAuth` / `withProjectAuth`).
- Instance-admin management UI: create orgs, switch org/project from the sidebar, and manage people from a **Users** console. Instance admins see and manage every org.
- Shared context is dual-tier: docs, secrets, and databases compose from org-level + project-level + job-linked sources into each run's `/next` payload.

### Onboarding & auth

- First-run setup is a shell flow (`harbour setup`, or `harbour admin create` for scripted installs) with argon2id password hashing and a token-based set-password link for inviting users. There is no unauthenticated web signup route to lock down.
- The session cookie's `Secure` flag tracks the actual connection protocol (`X-Forwarded-Proto`, falling back to the request protocol), so a production build served over `http://localhost` works in every browser while real TLS deployments stay `Secure`.

### Workflows

- Standalone **workflow runners** — deterministic, shell-based scheduled jobs with no agent and no LLM, claimed via `GET /api/workflows/next` with workflow-runner credentials.
- Non-interactive workflow runs with live runner updates, a hardened kill path (SIGTERM → SIGKILL escalation), and claim-race guards so two runners polling one org can't double-claim a run.

### Runs

- The run lifecycle is a mechanically-enforced state machine: a transition guard at the single `updateRunStatus` chokepoint, an execution-enforced finalize turn, and a flexible pre/postrun gate.

### Agents

- Per-agent **local vs. remote** choice at create time, with cli/model/thinking resolved live from the `/next` payload so a remote machine never needs reconfiguring when you change settings in the dashboard.
- The `/next` agent block is authoritative over local runner config; runs inject database ids and columns so agents can write to shared tables.

### Design & dashboard

- New v2 design language — "monochrome chrome, chromatic signal" — across every page; the client data layer was rebuilt on React Query with org/project scope wiring and shared UI primitives.
- The **Env Vars** feature is now labeled **Secrets** throughout the dashboard (the `/env-vars` route, `env_vars` table, and API are unchanged).

### Fixes

- `POST /api/jobs` rejects an `agentId` instead of silently dropping it; Captain requires an org scope and New Chat is deterministic; an agent can read its own run status; new users get org membership at creation; org-switcher dropdown grouping; tidier interactive `harbour setup` password prompts.

## v1.16.0 — 2026-05-20

### Runs

- New **Runs** history page with URL-backed filters for date range, agent, job, status, sort order, and optional skipped-run inclusion. The page loads 25 runs at a time with pagination instead of redirecting to the dashboard.
- Job and Agent detail pages now fetch their own run history through dedicated endpoints (`GET /api/jobs/:id/runs`, `GET /api/agents/:id/runs`) instead of client-filtering the global recent-runs pool. Older per-job/per-agent runs are visible even when they fall outside the dashboard's recent window.
- Recent/history views now include killed runs as real terminal runs. Skipped workflow-gate runs remain hidden by default, with an explicit history-page toggle.
- Run rows were extracted into a shared component and now label one-off/manually triggered runs with a **Manual** badge.
- Runs now have short titles. Harbour seeds a placeholder title at run creation, injects a first-step title-setting preamble into `/next`, and exposes `PUT /api/runs/:id/title` so agents can rename the run before doing work. Run lists and detail headers show the title first with the job name as secondary context.
- Jobs support a `titleFormat` hint so users can guide how agents name runs. The worker and admin API docs now document the new title endpoint and payload fields.

### Security

- Harbour runner API keys and Bearer tokens are now redacted before run activity and streamed run output are stored. This prevents tool-call logs such as `curl -H "Authorization: Bearer hbr_..."` from exposing live runner credentials in the dashboard or database.

### Fixes

- Running or waiting runs no longer block unrelated future scheduled runs for the same job. Harbour now checks only active `scheduled`, `running`, or `pending` runs when deciding whether a recurring job should enqueue another run.
- SQLite table-recreate migrations now disable foreign keys around the `CREATE/INSERT/DROP/RENAME` sequence. This prevents migration-time cascades from deleting runs, activity, output, or attachments when parent tables are rebuilt.
- Claude Code effort options now include `xhigh`, matching the installed CLI's current `--effort` ladder.
- Lint is clean across the project.

## v1.15.0 — 2026-05-08

### Security

- **Per-agent permission opt-in for Claude Code agents.** Previously every `claude -p` invocation passed `--dangerously-skip-permissions`, bypassing the permission system entirely and making per-agent constraint impossible. Now the runner drops that flag whenever the agent's workspace contains a valid `.claude/settings.json` with a `permissions` object, letting you scope individual agents (deny `sqlite3`/`rm`/`ssh`, deny reads of `.env*` and `~/.ssh`, restrict `WebFetch` to allow-listed domains, add `PreToolUse` hooks for argument-level checks). Detection is hardened against TOCTOU and malformed configs: symlinks-to-`/dev/null`, zero-byte files, and corrupt JSON all fall back to the legacy unrestricted mode rather than silently switching to a half-configured permission system. Agents without a settings file see zero behavior change. Recommended layout: `~/.harbour/workspaces/<agent>/.claude/settings.json` with `permissions.defaultMode: "dontAsk"` so unrecognized tool calls auto-deny instead of blocking on a prompt that has no UI under `-p`.
- **Job env vars now reach the agent's shell.** `runCliTool` accepts an `extraEnv` map; the runner layers `payload.env` onto the spawned process environment so the agent can write `curl -H "Authorization: Bearer $TOKEN"` without referencing the secret as text in the LLM-emitted Bash command (which `dontAsk` mode auto-denies). For agents without job-linked env vars, `payload.env` is `{}` and the spawn env is unchanged.
- **Workspace `bin/` on PATH.** If an agent's workspace has a `bin/` directory, the runner prepends it to the spawned PATH so per-agent wrapper scripts (e.g. an `auth-curl` shim that internally reads env vars and execs `curl` with the right headers) resolve as bare command names. The agent's emitted command stays free of `$VAR` references; the wrapper's internal env-var use is invisible to the permission layer.

### Agents

- New **Eager polling** toggle on harbour agents. When on, the runner drains the job queue back-to-back instead of waiting for the next 60s launchd tick — useful for clearing a backlog. The loop continues only on clean outcomes (`done`/`waiting`/`skipped`); `failed` and `killed` runs exit so transient issues (network, rate limits, OOM, timeouts) get a free 60s backoff. Hard cap of 50 iterations per tick. Off by default; enable per-agent in the agent's Settings dialog or at create time. The flag is read live from the `/next` payload, so dashboard toggles take effect on remote runners without reconnecting.

### Documentation

- New `docs/` tree organized into concepts, guides, and reference. Indexed at [docs/README.md](docs/README.md) and linked from a new Documentation section in the top-level README. Every page was validated against a freshly initialized instance — register a user, mint admin and agent keys, exercise every documented endpoint and check payload shapes — before landing.
- `GUIDE.md` (the worker-agent wire contract served at `/api/guide`) caught up with reality: `/next` job and attachment shapes now list every field the API returns (`workflow_only`, `timeout_minutes`, `run_id`, `embed_provider`, `created_at`, …); the status enum includes `killed`; retry coverage extends to `killed` runs; the five `?peek=true` response shapes are documented; default upload cap corrected to 500MB.
- `ADMIN_GUIDE.md` (the admin-key wire contract served at `/api/admin-guide`) caught up too: `schedule` must be a JSON string (object form returns 400); `timeout_minutes` is update-only as `timeoutMinutes`; the PUT field is `active`, not `archived`; added `GET /api/env-vars/:id/value`, `DELETE /api/runs/:id`, `POST /api/runs/:id/kill`, and the unlink endpoints.
- `src/lib/paths.ts` comment fixed: `HARBOUR_MAX_UPLOAD_MB` defaults to 500MB, not 100MB.

### Fixes

- **Codex model dropdown** refreshed to current ChatGPT-tier models: `gpt-5.5` (default) and `gpt-5.4`. Removed `o3` and `gpt-4.1` (no longer accessible on ChatGPT-account logins). Reasoning levels gain `xhigh` to match Codex's current ladder.
- **Codex CLI 0.128+ and Gemini CLI 0.40+ flag drift** ([#24](https://github.com/geekforbrains/harbour/issues/24), reported and patched in a fork by [@PoliTwit1984](https://github.com/PoliTwit1984)). Both upstream CLIs removed flags Harbour was passing, causing every Codex/Gemini-backed run to fail at argument parsing before the model was invoked. Codex now uses `-c model_reasoning_effort=<level>` instead of the removed `--reasoning-effort`. Gemini drops `--thinking` entirely (reasoning depth is controlled by model selection now) and adds `--skip-trust` for headless runs in non-trusted workspace dirs. The dashboard's thinking selector is now hidden for Gemini agents since the option is no longer wired through. New unit tests in `src/__tests__/providers.test.ts` lock in the argv shape for all three providers so future flag drift is caught in CI.
- `POST /api/agents/:id/jobs` and `PUT /api/jobs/:id` no longer 500 when the body's `schedule` is a JSON object — `normalizeSchedule()` now type-guards its input and returns `null` for non-strings, so the route's existing 400 path handles it.
- `POST /api/jobs` (workflow-only) now stores the **canonical** schedule. Previously a valid input like `"hourly"` or `"every 5 minutes"` landed in the column verbatim; the schedule advancer can't read those, so `next_run_at` stayed null and the job never fired. Switched from `isValidSchedule` to `normalizeSchedule` and pass the result to `createJob`.

## v1.14.0 — 2026-05-05

### Captain

- New **Captain** dashboard page — an in-browser chat with a CLI tool (Claude Code, Codex, or Gemini CLI) that runs server-side and streams output back over SSE. Lets you ask questions, inspect runs, query the database, and manage Harbour conversationally without leaving the UI.
- Multi-conversation support with session continuity per conversation. Stop/cancel a running response mid-stream; old conversations are preserved and resumable.
- Tool calls render as collapsible blocks inline with the assistant's text, separate from the prose. Markdown rendering with paragraph breaks preserved between text blocks (Anthropic's stream emits no separator between text content blocks within a turn — Captain injects one).
- Rotating nautical-themed thinking messages while waiting on the model; spinner is replaced by streamed text once the response begins.
- Captain workspace at `~/.harbour/captain/` is auto-provisioned on first use with a `CLAUDE.md` describing Harbour's schema, API endpoints, and key paths. `AGENTS.md` and `GEMINI.md` are symlinked to the same file so all three CLIs share one knowledge base. Files are never overwritten, so you can customize them.
- New Settings panel for Captain: pick CLI tool, model, thinking/effort level, and override the working directory.
- Mobile layout: slide-out conversation drawer triggered from the header; new chat button in the header; input bar correctly positioned above the bottom nav.

## v1.13.0 — 2026-04-16

### DigitalOcean deployment

- New Terraform config in `terraform/` spins up a single Ubuntu 24.04 droplet running Harbour behind Caddy (HTTPS + Basic Auth), with fail2ban, UFW, unattended security upgrades, and the three AI CLIs pre-installed. One `terraform apply` brings a production box online in ~5 minutes. (The `terraform/` config was removed in v2 — see [deploying to production](docs/guides/deploy-to-production.md) for the current path.)
- Production runs Harbour directly under systemd (not Docker) as a dedicated non-root `harbour` user — required because Claude Code refuses `--dangerously-skip-permissions` under root. Both the Next.js server and the agent runner run as sibling systemd services.
- Python 3 + pip + venv + pipx pre-installed so the harbour user can run Python-based agent tooling without manual bootstrap.
- Fail2ban's Caddy Basic Auth jail only counts 401s where an Authorization header was actually sent — so legitimate users don't self-ban on normal page loads (manifest, favicon, initial nav all arrive uncredentialed and would otherwise trip the jail).
- Local dev with Docker (`make run`) unchanged.

## v1.12.0 — 2026-04-15

### Mobile
- Run detail view now renders file attachments inline within the activity feed. Image attachments (PNG, JPG) display as expandable thumbnails; other files show as downloadable links. Previously, attachments uploaded via the API were invisible in the UI.
- Run detail header now stacks into two rows on mobile breakpoints: title on row 1 (full width), status badge and action buttons on row 2. This prevents layout collisions with long job names like "Hearsay Nightly Review" and eliminates text wrapping issues around the status badge.

## v1.11.1 — 2026-04-14

### Mobile
- Edit-job dialog now includes Docs and Env Vars management (chip lists with add/remove), matching the create-job dialog. Previously, managing these links on mobile required the detail-page X buttons, which were hover-only and unreachable on touch.
- Detail-page Docs/Env Vars X buttons are always visible below the `sm:` breakpoint (hover-only is desktop behavior now).

## v1.11.0 — 2026-04-14

### Remote Runners

- Harbour agents can now run on a different machine than the harbour server — useful when a job needs a specific host (iOS/Xcode builds on a Mac, GPU work on a workstation, etc.) while the server lives elsewhere.
- New **"Run on a different machine"** toggle in the New Agent dialog (harbour agents only) skips local runner-config installation and exposes a `harbour agent connect <blob>` command instead.
- New CLI subcommand: `harbour agent connect <base64-blob>` — decodes the blob, verifies auth against `/api/agents/:id/next?peek=true`, and writes the entry to the remote machine's `~/.harbour/runners.json`.
- Agent detail page has a **Connect Remote Runner** action that rotates the API key and generates a fresh connect command (useful if the original is lost).
- Job form warns when the selected agent is remote: workflow gate scripts must live at `~/.harbour/workflows/` on the remote machine, not the server.
- Remote-only runners skip the `/api/workflows/next` poll — agentless workflow-only jobs stay with the runner co-located with the harbour server.
- New `agents.remote` column (migration handled automatically on startup).

### Docker

- Added `Dockerfile.runner` — minimal node image that runs just `harbour agent run` on a 60s loop.
- New `harbour-remote` compose service (under the `remote` profile) for end-to-end validation of the remote-runner flow on a single host.

### Documentation

- README: new "Running the runner on a different machine" section with the connect flow, reachability notes, and workflow-script caveat.

## v1.10.1 — 2026-04-14

### Mobile
- Render agent-uploaded attachments in the mobile run activity view

## v1.10.0 — 2026-04-13

### Workflow Jobs
- New execution mode: workflow-only jobs run shell commands on a schedule with no agent or LLM
- Three modes: agent-only (default), workflow + agent (workflow gates the agent), workflow-only
- Workflow-only jobs don't require an agent — standalone scheduled commands
- Exit code protocol: 0 = success/done, 77 = skip, any other non-zero = failure
- Runner receives full run payload (JSON) on stdin, executes in `~/.harbour/workflows/`
- `check_command` renamed to `workflow_command` with new `workflow_only` flag

### Agentless Jobs
- Jobs and runs no longer require an agent (`agent_id` nullable)
- `POST /api/jobs` endpoint for creating workflow-only jobs without an agent
- `GET /api/workflows/next` endpoint for runner discovery of agentless runs
- Runner polls for agentless workflow runs alongside per-agent polling
- `requireAgentOwnership` passes through for agentless runs

### Jobs Page
- Jobs split into "Agent Jobs" and "Workflow Jobs" sections
- Workflow-only jobs show without agent name

### Create Dialog
- Agent/Workflow type toggle with Bot and Terminal icons
- Workflow-only mode hides agent selector, instructions, and model/thinking fields
- Workflow-only jobs route to `POST /api/jobs` (no agent required)

### Run Icons
- Workflow-only runs show Terminal icon instead of Bot in runs list and detail
- Workflow + agent runs show both Bot and Terminal icons
- Run detail page shows "Workflow" label instead of agent link for agentless runs
- Subtitle updated from "All run activity across agents" to "All run activity"

### Documentation
- README: new Workflows section, updated API table, /next endpoints docs
- ADMIN_GUIDE: workflow-only job creation endpoint and common workflow
- GUIDE: exit code 77 clarification on skipped status
- CLAUDE.md: updated conventions and key paths for workflow system

## v1.9.2 — 2026-04-10

### Bug Fixes

- **Schema migration safety**: Each `CREATE TABLE runs_new` migration block now drops any pre-existing `runs_new` table first. Without this guard, an interrupted migration (e.g. mid-restart) left an orphaned `runs_new` table that caused every subsequent startup to abort schema initialization, leaving the `runs` table missing columns (`kill_requested_at`, `extra_instructions`, `session_id`, `session_cwd`) and breaking all endpoints that touched those columns.

- **`ORDER BY rowid` for linked databases**: `getRows()` in `database.ts` and `buildRunPayload()` in `runs.ts` both sorted linked agent-managed tables by `_id DESC`. Tables created before v1.9 use `id TEXT PRIMARY KEY` and have no `_id` column, causing a `SqliteError: no such column: _id` inside `buildRunPayload()`. Since `buildRunPayload()` is called after a run is already claimed (status set to `running`), the error caused the `/next` polling endpoint to return 500 while the run remained permanently stuck in `running`. Switching to `rowid` works for both old (`id TEXT`) and new (`_id INTEGER`) table generations.

## v1.9.0 — 2026-04-10

### Run Detail Actions
- Dropdown menu on finished and waiting runs to change status (done/failed/skipped/killed/waiting) or delete the run
- New `DELETE /api/runs/:id` endpoint with attachment cleanup

### Copyable Resume Command
- Run detail page shows a ready-to-paste CLI resume command for harbour-agent runs (e.g. `cd ... && claude --resume <id>`)
- Runner reports session ID and working directory via `PUT /api/runs/:id/session`

### Console Output
- Tool call details now shown in harbour-agent console output — displays the actual tool invocation (command, file path, pattern) instead of just the tool name for Claude Code agents

## v1.8.0 — 2026-04-09

### Trigger & Pause/Play on Runs Page
- Pause/play and trigger (zap) buttons now appear on every run row in the runs list
- Trigger button opens a confirmation dialog with optional additional instructions
- Pause/play toggles the parent job's active state directly from the run list
- Job detail page trigger also upgraded from `confirm()` to the shared trigger dialog

### Trigger with Additional Instructions
- Manual triggers accept optional extra instructions injected alongside job instructions
- Extra instructions stored on the run and merged into the `/next` payload for agents
- A system activity message is posted to the run's thread showing the additional context
- New `extra_instructions` column on runs table, `TriggerDialog` shared component

## v1.7.0 — 2026-04-09

### Inline Attachments & One-Off Run Attachments
- Attachments now appear inline in the activity feed (Slack-style) instead of a separate section
- Attach files when creating one-off runs — staged locally, uploaded on submit
- Docs, Env Vars, and Attachments sections restyled as card-like areas with better visibility
- "When" picker moved to the bottom of the run creation dialog

### Safari File Input Fix
- File input rendered outside dialog portal to avoid Base UI event interference
- Uses ref-based state to prevent stale closures on form submission
- Client-side file size validation with inline error display
- Server-side upload errors surfaced via alert instead of silently swallowed

### Other Changes
- Default max upload size increased from 100MB to 500MB (`HARBOUR_MAX_UPLOAD_MB`)

## v1.6.0 — 2026-04-09

### Kill Running Runs
- Kill button on the run detail page for harbour-agent runs — stops a stuck or misdirected run mid-execution
- Runner detects kill via piggyback on `POST /output` responses (~750ms) or a 10s fallback poll
- SIGTERM with 3-second grace period, then SIGKILL if the CLI hasn't exited
- CLI session is saved on kill — comment on the killed run to resume, and the agent picks back up with full prior context via `--resume`
- New `killed` status (orange badge) — killed runs can be retried or resumed via comment
- Kill hidden for external agents (no local runner to signal); follow-up tracked in #14
- New endpoint: `POST /api/runs/:id/kill`, `GET /api/runs/:id/kill`

## v1.5.0 — 2026-04-08

### Run Attachments
- Attach files (screenshots, PDFs, exports) and video URL embeds (Loom, YouTube, Vimeo) to runs
- Reply composer supports click-to-attach, drag-and-drop, paste-image (CMD+V screenshots), and paste-embed-URL
- Files stream to disk via busboy with configurable per-file cap (`HARBOUR_MAX_UPLOAD_MB`, default 100)
- Attachments appear inline in the activity thread; embeds render as iframes
- Bundled into the `/next` payload so agents see what humans attached, with auth-gated file download URLs
- Harbour runner renders attachments inline under their activity entries and documents the curl download recipe for the CLI tool
- Cascade delete removes both DB rows and on-disk directories when a run is deleted

### ~/.harbour Home Directory
- All on-disk state now lives under `~/.harbour` by default — database, uploads, encryption key, and runner config
- Single backup of `~/.harbour` captures everything
- Existing `./harbour.db` auto-migrates on first start (originals preserved)
- Configurable via `HARBOUR_HOME` with per-path overrides (`HARBOUR_DB_PATH`, `HARBOUR_UPLOADS_DIR`, `HARBOUR_ENCRYPTION_KEY`)

### Fixes
- Proxy-aware absolute URLs: `publicBaseUrl()` honours `X-Forwarded-Host` / `X-Forwarded-Proto` so attachment URLs work behind reverse proxies (e.g. Tailscale Serve) instead of baking in `localhost:3000`

## v1.4.0 — 2026-04-02

### Admin API Keys
- Admin API keys for external agents to manage Harbour remotely with full user-level access
- Create and revoke keys from Settings page, each with a name and last-used tracking
- Key shown once on creation as a copyable invite snippet with URL and bootstrap instructions
- Admin keys resolve to the creating user's identity for audit trails
- Admin guide served at `/api/admin-guide` — full API reference for management agents
- Keys prefixed `hbr_adm_`, stored as SHA-256 hash (never plaintext)

### Projects
- Optional projects for organizing work — a view layer over agents, jobs, docs, env vars, and databases
- Project switcher in sidebar (desktop) and header (mobile) with create/switch/all views
- "Add Existing" buttons on all list pages when viewing a project
- Auto-link: creating items while in a project links them automatically
- Auto-link dependencies: adding a job to a project pulls in its agent, docs, env vars, and databases
- Project settings in Settings page — rename and delete (with confirmation)
- All list API endpoints accept optional `?projectId=` filter
- Deleting a project only removes grouping — no entities are affected

## v1.3.0 — 2026-04-01

### Jobs
- Trigger run button — instantly start a run for any job (paused or active) with confirmation dialog
- Per-job CLI timeout — runner uses each job's `timeout_minutes` setting instead of a hardcoded 10-minute limit
- Re-activating a paused job now computes `next_run_at` from the schedule

### Runs
- Comment on done/failed runs to reopen them as pending — continues the conversation with the agent
- Reply form visible on waiting, pending, done, and failed runs (hidden for running/scheduled/skipped)
- Sanitized error output — timeout and crash errors now show a human-readable reason instead of raw streaming JSON protocol lines
- Output section hidden for external agent runs (only shown for harbour agents)

### Runner
- Pre-run check commands now execute as shell processes — the runner runs the command directly, pipes the full payload JSON to stdin, and appends stdout to the prompt (exit 0 = proceed, exit 1 = skip, exit 2+ = error)
- CLI tool detection uses extended PATH (homebrew, .local/bin, npm-global) for version checks

### Settings
- Configurable "Recent Runs Shown" limit — controls how many completed runs display on the main Runs page (default: 10)

### UI
- Version number shown in sidebar footer and mobile More menu

## v1.2.0 — 2026-03-31

### Environment Variables
- Encrypted env vars (AES-256-GCM) with key stored at `~/.harbour/encryption.key`
- Create, edit, delete env vars from the dashboard with eye-toggle to reveal values
- Pin env vars to auto-attach to all new jobs and one-off runs
- Link env vars to jobs (same pattern as docs)
- Decrypted values injected into `/next` payload as `env` object
- Runner injects env vars into agent prompts as named credentials
- Supports `HARBOUR_ENCRYPTION_KEY` env var override

### Settings
- New Settings page with system-wide configuration
- Timezone: auto-detected from system on first run, searchable dropdown of all IANA timezones
- Timezone used in all schedule calculations and time display
- Signup toggle: enable/disable new user registration

### Per-Job Model & Thinking
- Model and thinking/effort level configurable per agent (default) and per job (override)
- CLI-specific options: Claude (effort: low/medium/high/max), Codex (reasoning: low/medium/high), Gemini (thinking: low/medium/high)
- Agent detail page shows type, CLI tool, model, and thinking level
- Runner reads job-level overrides from `/next` payload, falls back to agent defaults
- Model/thinking changes synced to `~/.harbour/runners.json`

### Unified Create Dialog
- Single "New Run / New Job" dialog with tabs, shared fields persist when switching
- Both tabs support docs and env vars selection with picker sub-dialogs
- Pinned docs and env vars auto-selected on dialog open
- Model and thinking selectors shown for harbour agents on both tabs
- Replaces separate New Run and New Job dialogs on their respective pages

### Pinned Docs
- Pin/unpin toggle on docs list and detail views
- Pinned docs appear at top of docs list
- Pinned docs auto-attached to all new jobs and one-off runs
- Can still be manually removed from individual jobs

### Run Improvements
- Retry button on failed/skipped runs (sets status to pending, agent picks up on next poll)
- View Job button always visible on run detail (including one-off runs)
- Live streaming output from harbour agent CLI runs

### Job Detail Improvements
- Docs section with proper card layout and add dialog (replaces inline dropdown)
- Env vars section with same pattern
- Databases section with card layout

### UI Polish
- Consistent empty states with centered icons matching nav menu across all views
- Agent detail shows type (Harbour/External), CLI tool badge, model, and thinking level
- Invite and API key buttons only shown for external agents
- Error feedback on all dashboard mutation operations

### Runner Reliability
- Startup timeout (30s) kills hung CLI processes (e.g. unauthenticated Gemini)
- Stdin closed immediately to prevent interactive prompt hangs
- Stderr included in error activity logs for better diagnostics

### Security & Code Quality
- `withAuth`/`withUserAuth` higher-order function wrappers replace manual auth boilerplate across all 36 API routes
- Agent ownership enforcement: agents can only act on their own resources (runs, status, activity, output)
- `orderBy` parameter validated against actual column names in database rows endpoint
- Composite indexes on `jobs(agent_id, active, next_run_at)` and `run_activity(run_id, created_at)`
- `getAgentNextRun()`, `createJob()`, and `createOneOffRun()` wrapped in transactions for atomicity
- Deduplicated `advanceSchedule` — single implementation in `jobs.ts`
- Shared `ModelThinkingSelect` component replaces 4 duplicate select blocks

## v1.1.0 — 2026-03-30

### Harbour Agents
- Built-in agent runner for Claude Code, Codex, and Gemini CLI
- New Agent dialog: choose **Harbour Agent** (local CLI) or **External** (bring your own)
- Auto-detect installed CLI tools with version display
- CLI badge on agent list items, "Runner not active" banner
- Runner config auto-saved to `~/.harbour/runners.json` on creation, cleaned up on deletion
- `npm run harbour -- agent install` sets up a macOS launch agent (launchd) for automatic polling
- `npm run harbour -- agent list/run/uninstall` for runner management
- Session tracking for CLI tool conversation resumption across runs
- Providers: Claude (`--dangerously-skip-permissions`), Codex (`--dangerously-bypass-approvals-and-sandbox`), Gemini (`--yolo`)

### Schema
- Agents table: added `type` (harbour/external), `cli`, `model` columns with auto-migration

## v1.0.0 — 2026-03-30

Initial public release.

### Core
- Agent registration with API keys and invite system
- Job scheduling (intervals and weekly) with pre-run checks
- Run lifecycle: scheduled, running, waiting, pending, done, failed, skipped
- One-off runs created from the dashboard
- Configurable job timeouts with automatic stale run cleanup
- Docs system with revision history, linked to jobs
- Agent-managed databases with schema migrations, linked to jobs

### Dashboard
- PWA-ready responsive UI (mobile + desktop)
- Runs view with running, scheduled, waiting, pending, and recent sections
- Jobs view with run/skip counts
- Agent management with invite text and key rotation
- Doc editor with revision history
- Database browser

### Agent API
- Polling-based work distribution (`/next` and `?peek`)
- Activity logging with markdown support
- Human-in-the-loop via waiting/pending flow
- Full CRUD for docs and databases
- Self-serve API guide at `/api/guide`
