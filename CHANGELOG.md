# Changelog

## Unreleased — 2026-05-20

### Runtime Security

- Added SAGE runtime security with `@gendigital/sage-core@0.9.0` and `@gendigital/sage-openclaw@0.9.0`.
- Added the Harbour SAGE guard, Hermes `pre_tool_call` hook, setup script, and workflow `bash -c` preflight so `deny` and `ask` verdicts fail before execution.
- Added OpenClaw/Hermes runtime coverage checks before CLI spawn, with unknown future providers failing closed until mapped to SAGE-native or wrapper coverage.
- Added `runtime_security` metadata to `/api/toolkit-libraries` and OpenClaw/Hermes run payloads.
- Tightened setup docs to the exact pinned OpenClaw SAGE install command and added direct `yaml@2.9.0` dependency metadata for the setup script; the follow-up dependency audit patch moves Next to `16.2.6`.
- Excluded nested `deer-flow` and `freellmapi` workspaces from Harbour Vitest so `npm run test` covers Harbour's own test suite cleanly.
- Upgraded Next.js to `16.2.6` and pinned PostCSS resolution to `8.5.15`, clearing the Docker/npm audit baseline to zero known vulnerabilities.

### Deploy

- Prepared the current Harbour packet for deployment after clearing full lint to zero warnings and re-verifying TypeScript, production build, whitespace checks, and browser smoke.
- Fixed the Docker standalone runtime packaging by copying Next 16/Turbopack server chunks and hashed external native modules into the runtime image.
- Rebuilt the Docker deployment after the dependency security patch so the running image no longer reports the previous Next/PostCSS audit findings.

### Toolkit Libraries

- Added `agent_compatibility` storage and filtering for imported skills, skill proposals, OpenCLaw/Hermes run payloads, and `/api/toolkit-libraries`.
- Added OpenCLaw/Hermes compatibility badges and filters to the Libraries UI.
- Synced the new daily `openclaw-skill-scout` AgentOps agent/job so OpenCLaw can scan and promote vetted community skill wrappers after the morning toolkit sync.

### Interface

- Rethemed Harbour around the NeoClaw reference visual system: Red Hat Display UI type, Georgia headings, paper-gray background, soft white panels, black primary actions, rounded app frames, and blur-in motion.
- Updated the shared shell, mobile navigation, auth screens, Captain, buttons, cards, dialogs, inputs, textareas, empty states, and status bar so every route inherits the BORG Interface look.

### Notifications

- Added a Harbour notifications inbox backed by a `notifications` table, unread/read/archive lifecycle, unread badge count, and expandable intelligence brief cards.
- Moved the old Inbox meaning out of the sidebar: waiting/running/scheduled/recent runs now live under All Runs page filters.
- Added run-completion ingestion for GitHub Trend Intelligence `harbour-notification-json` payloads, creating one Inbox notification per daily brief.
- Added archive-triggered BORG Synergy Analyst runs; archiving a notification marks analysis pending, queues a one-off analysis run, and updates the notification when structured synergy JSON is emitted.
- Hardened notification archiving to be idempotent, mark archived notifications read, and expose archived notification history from the Inbox page.
- Fixed GitHub Intelligence local execution setup by syncing AgentOps-declared local agents into `~/.harbour/runners.json` and normalizing signal-only CLI exits so failed starts finalize instead of leaving runs stuck.
- Increased the Hermes/OpenClaw startup watchdog window for large Harbour prompts so daily intelligence jobs are not killed before first output during legitimate long startup.
- Fixed production build warnings by adding a stable metadata base and marking external toolkit registry reads as Turbopack trace-ignored, preventing standalone traces from pulling in generated data, nested workspaces, and graph artifacts.

### Social Intelligence

- Kept the operator-facing Social nav surface aligned with stable `/social` routes and API names.
- Added a first-class Social section with platform pages for overview, Meta/Instagram, YouTube, X.com, TikTok, LinkedIn, and distribution.
- Added platform-specific dashboard sections for Instagram/Reels, YouTube Shorts/long-form analytics, X.com conversations, and Blotato/Ominsocial distribution state.
- Added authenticated `/api/social/*` proxy/fallback routes that can hand off to `SOCIAL_ENGINE_URL` or return local scaffold data until the external FastAPI engine is live.
- Added shared Social source-adapter, access-policy, MCP tool, worker-partition, and distribution-provider contracts.

### Navigation

- Renamed Jobs to Goals in the operator navigation and primary list/create surfaces while keeping the existing `/jobs` route and data model stable.
- Moved Users and Env Vars out of the primary navigation and into Settings tabs to reduce sidebar and mobile More menu clutter.

### Lint

- Cleared the full Harbour ESLint error baseline by documenting the current dynamic SQLite/API row typing policy, fixing React Compiler state/ref violations in run, create, and project-link surfaces, and preserving remaining lint output as warnings only.
- Removed the remaining warnings so `npm run lint` now exits with zero errors and zero warnings.

### AgentOps Sync

- AgentOps-synced Harbour jobs now compute `next_run_at` when an active default job is imported from the toolkit sync, so scheduled agents such as `github-trend-intelligence-daily` are actually due inside Harbour after sync.
- Synced `yt-pipeline-full` from AgentOps as the project-scoped **YouTube Scraper Agent — Full Pipeline** Harbour agent.
- Added the inactive on-demand `yt-pipeline-full-on-demand` job and local runner config without scheduling or creating any YouTube runs.
- Guarded the job instructions so safe checks default to dry-run discovery and execution requires explicit channel/video scope.
- Linked AgentOps-synced default jobs into their project scope so project-filtered Harbour job views include imported agent jobs.

### Deployment

- Added a Caddy edge service to the Docker stack so the Harbour dashboard and `/api/*` routes can be served on host ports `80` and `443`, while keeping `3030` as a direct Next.js fallback.
- Added `deploy/Caddyfile` so generated agent, attachment, and API links can use Caddy's forwarded public dashboard origin behind the proxy.
- Trimmed nested workspaces and generated graph output from the Docker build context so production image builds stay focused on Harbour.

### Credential Profiles

- Added per-person credential profiles and provider credential records backed by encrypted env vars.
- Added broker injection so profile-linked provider secrets are exposed to runs only as canonical env names such as `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, and `GITHUB_MODELS_API_KEY`.
- Redacted linked env var and credential-profile broker secrets from run activity and stored run output.
- Added authenticated credential profile API routes for profile and provider credential management.
- Added visual-artifact quarantine for credential-profile runs and a dry-run-by-default provider smoke harness for read-only auth checks.

### BORG Interface Workspaces

- Added first-class workspaces above projects so businesses and operating areas can own nested projects.
- Seeded BORG Interface, AGENT RESEARCH, CULTR VENTURES, and PhaseOne workspaces with their known projects.
- Updated the sidebar/mobile selector to choose workspaces and projects separately.
- Updated Captain guidance and Harbour docs for the new BORG Interface paths.
- Added workspace-scoped filtering for agents, jobs, runs, docs, env vars, and databases.
- Kept all projects available in the selector while workspace scope filters dashboard views.
- Added duplicate workspace conflict handling and safer one-time legacy workspace migration behavior.
- Replaced stale FreeLLM UI start paths with BORG Interface paths.

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

- New Terraform config in `terraform/` spins up a single Ubuntu 24.04 droplet running Harbour behind Caddy (HTTPS + Basic Auth), with fail2ban, UFW, unattended security upgrades, and the three AI CLIs pre-installed. One `terraform apply` brings a production box online in ~5 minutes. See [`terraform/README.md`](terraform/README.md).
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

### Video Processing & Storyboard
- Auto-process uploaded videos into screenshots (ffmpeg) and transcripts (Whisper, OpenAI, Gemini)
- Transcript providers now return timestamped segments for time-aligned output
- Storyboard generation pairs each screenshot with its corresponding transcript text by time window
- `/next` endpoint includes storyboard field so agents see screenshots + transcript interleaved
- Transcript API serves storyboard by default (`?format=plain` for raw text)
- Processing status, screenshot gallery, and transcript viewer on the run detail page
- Manual Process/Retry buttons for video attachments
- Video processing settings: auto-process toggle, screenshot interval, transcript provider, API keys

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
- Extracted `normalizeSegments` helper to DRY transcript provider code

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
