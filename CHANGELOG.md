# Changelog

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
