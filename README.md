# Harbour

A control plane for AI agents doing ongoing work.

![Harbour Dashboard](public/screenshot.png)

> I do AI consulting for agencies and busy professionals — helping teams get real, ongoing work out of agents without it becoming a second full-time job. Always happy to hop on a call and figure out how I can be helpful: [gavin@geekforbrains.com](mailto:gavin@geekforbrains.com).

## Why

AI agents can handle real, ongoing responsibilities — marketing, support, dev. They post content, triage tickets, manage campaigns, submit PRs. Most of this runs on recurring schedules.

The problem is visibility. What jobs does each agent have? What ran today? What needs my attention? What broke?

Harbour is the layer underneath your agents — managing what recurring work each has, giving them shared context through docs and data, and surfacing the things that need you.

## How It Works

Harbour is a polling-based control plane. It never calls out to agents — they pull work on their own schedule.

**Jobs** are recurring responsibilities with a schedule, instructions, and references to docs, data, and env vars. When a job fires, it creates a **run**. Jobs come in two flavors: **agent jobs** where an AI agent does the work, and **workflow jobs** where a shell command handles everything — no LLM involved. A job can also combine both: a workflow runs first as a gate, and the agent only fires if the workflow exits successfully. Agents poll for runs, do the work, post updates, and set a final status — or set it to **waiting** if they need human input.

**Docs** are shared markdown documents (brand guidelines, processes, strategy) injected into runs automatically. **Databases** are SQLite tables agents create and manage through the API, also injected into runs. **Env Vars** are encrypted key-value pairs (API keys, tokens) decrypted and injected at runtime.

### The `/next` Endpoints

Agent jobs are discovered through `GET /api/agents/:id/next`. The response bundles everything: run context, job instructions, docs, database rows, env vars, and an `api` section with pre-resolved endpoints and status options for the run. Agents use `?peek=true` to check for work without claiming it.

Workflow-only jobs that have no agent are discovered through `GET /api/workflows/next`. The harbour runner polls both endpoints automatically.

## Designing Your Agent Team

Agents process runs one at a time. While an agent is working on a run, its other jobs wait their turn. This is deliberate — each run gets the full agent, with no risk of two CLI processes colliding on the same working directory, session state, or API budget.

This shapes how you scale across multiple projects:

- **Small install / one project.** One agent per role (e.g. a single `Developer`) works well. Jobs queue behind each other, which is usually fine for daily or hourly cadence.
- **Multiple projects.** Create per-project agents — `ProjectA Developer`, `ProjectB Developer`, etc. — so work on different projects can run truly in parallel. Each one gets its own prompt, model, thinking level, and repo context. Use the **Projects** feature to filter the sidebar down to the agents and jobs for whatever you're focused on, so nine agents feels like three.

Docs, env vars, and databases are top-level and can be linked to any number of jobs across agents, so duplicating agents per project mostly means duplicating prompt/model config — not your shared knowledge base.

If you ever want a single agent running multiple jobs concurrently, that's a deliberate config surface we haven't added. The current design has been enough so far; the per-project pattern above is the intended answer.

## Getting Started

### With Docker (recommended)

Only requirement is Docker.

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
make run
```

Visit [http://localhost:3030](http://localhost:3030) and create your first account. All state (DB, uploads, encryption key) lives in `./data` — back up that directory and you have a snapshot of everything.

```bash
make logs     # follow logs
make down     # stop the container
make rebuild  # rebuild image and restart (after code changes)
make clean    # stop and wipe ./data (destructive)
```

To simulate a remote-runner setup end-to-end (see [Running the runner on a different machine](#running-the-runner-on-a-different-machine)), add the `remote` profile:

```bash
docker compose --profile remote up -d
```

This brings up a second container (`harbour-remote`) that polls the server and acts as if it were a separate machine. Useful for testing the connect flow locally before pointing a real Mac/Linux box at your harbour.

### Without Docker

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm install
npm run build
npm start
```

Visit [http://localhost:3000](http://localhost:3000) and create your first account.

### Deploy to DigitalOcean

Terraform config for a single-droplet deployment (Ubuntu + Caddy + Let's Encrypt + HTTP Basic Auth, running Harbour directly as a systemd service) lives in [`terraform/`](terraform/README.md). One `terraform apply` spins up a production-ready box in ~5 minutes.

### Updating

When Harbour is running under launchd on macOS, rebuilding in place leaves the running server referencing chunks that get replaced mid-build — pages render unstyled until the server restarts. Use the release script to rebuild and bounce the whole local stack:

```bash
npm run release
```

The script stops `com.harbour.server`, rebuilds, starts it back up, and then restarts `com.harbour.agent-runner` so it picks up any changes under `bin/`. If the agent-runner isn't installed, it's skipped. macOS only today; Linux/systemd support will land alongside a systemd install path.

### Harbour Agents

Built-in support for running agents via [Claude Code](https://claude.ai/claude-code), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli). A local runner polls for work, spawns your CLI tool, streams output to the dashboard, and posts the result as run activity.

1. Dashboard → **New Agent** → select **Harbour Agent** and pick your CLI tool
2. Name it, pick a model and thinking/effort level, create a job with a schedule and instructions
3. Install the runner:

```bash
npm run harbour -- agent install
```

The runner polls every 60 seconds. All configured agents and agentless workflow jobs run concurrently. Logs go to `~/.harbour/runner.log`.

```bash
npm run harbour -- agent list        # show configured agents
npm run harbour -- agent run         # manual poll (useful for testing)
npm run harbour -- agent uninstall   # stop the runner
```

The runner injects the Harbour API credentials and endpoints into each prompt, so harbour agents can set run status (`done`, `waiting`, `failed`), post activity messages, and manage docs and databases — just like external agents. If an agent doesn't set a final status, the runner marks the run as failed. Stuck or misdirected runs can be killed from the dashboard — comment on a killed run to resume the CLI session where it left off.

Model and thinking/effort levels can be set per agent (default) and overridden per job — letting you use a lighter model for routine tasks and a heavier one for complex work.

#### Eager polling

By default the runner pauses 60 seconds between runs, even when there's a backlog of pending work. Toggle **Eager polling** on a harbour agent to drain the queue without that pause: when a run finishes cleanly (`done`, `waiting`, or `skipped`), the runner immediately polls for another run instead of waiting for the next launchd tick. As soon as the queue empties, the agent falls back to the normal 60s cadence.

A failed or killed run breaks the eager loop — failures are most often transient (network, rate limits, timeouts), so the 60s gap acts as a free backoff. Eager mode trades latency for cost: stacking many LLM-driven runs back-to-back burns budget faster than the natural pacing. Off by default; enable per-agent in the agent's settings.

#### Per-agent permissions (Claude Code)

By default Harbour invokes Claude Code with `--dangerously-skip-permissions`, which bypasses the permission system entirely — necessary for non-interactive runs in the general case (no UI to handle approval prompts), but it also means a compromised agent (e.g. one fooled by prompt injection via untrusted user input) has the full surface of the host machine.

Drop a `.claude/settings.json` into a Claude-Code agent's workspace and Harbour switches that agent over to the permission system. Other agents are unaffected. With per-agent constraint you can:

- Deny dangerous binaries (`sqlite3`, `rm`, `ssh`, `scp`, `chmod`, `sudo`, …)
- Deny reads of secret files (encryption keys, `.env*`, `~/.ssh/`, …)
- Restrict `WebFetch` to allow-listed domains
- Add `PreToolUse` hooks for argument-level checks the static patterns can't express (e.g. URL allow-listing for `curl` when `-H "Authorization: ..."` precedes the URL)

Recommended layout:

```
~/.harbour/workspaces/<agent>/.claude/settings.json
~/.harbour/workspaces/<agent>/.claude/hooks/<hook>.sh
~/.harbour/workspaces/<agent>/bin/<wrapper>          # optional
```

A few things worth knowing:

- Set `permissions.defaultMode` to `"dontAsk"` so unrecognized tool calls are auto-denied. The default `"default"` mode would block waiting for an interactive prompt that has no UI under `-p`.
- Deny rules win over allow rules — make deny-list mistakes safe.
- `Bash(...)` patterns match the literal command string, so URL filtering inside `curl` is fragile; do that in a hook instead.
- Job-linked env vars are now layered onto the agent's shell environment, so prompts can use `$VAR` directly without leaking the secret as text in the LLM-emitted Bash command. The workspace's `bin/` directory (if present) is prepended to PATH so per-agent wrapper scripts resolve as bare command names.

Detection is conservative: a regular `settings.json` with a parseable `permissions` object is required. Symlinks to `/dev/null`, zero-byte files, and corrupt JSON all fall back to the legacy `--dangerously-skip-permissions` mode rather than silently switching to a half-configured permission system.

#### Running the runner on a different machine

Sometimes a job needs to run on a specific machine — iOS/Xcode builds on a Mac, GPU work on a workstation — while the harbour server lives elsewhere. Harbour supports this by letting you mark an agent as **remote**: harbour won't install a local runner for it, and you run the runner on the target machine instead.

1. On harbour, **New Agent** → Harbour Agent → pick a CLI → enable **"Run on a different machine"** → Create. Copy the `harbour agent connect <blob>` command.
2. On the remote machine, clone harbour and install dependencies:
   ```bash
   git clone https://github.com/geekforbrains/harbour.git
   cd harbour
   npm install
   ```
3. Paste the command on the remote machine:
   ```bash
   npm run harbour -- agent connect <blob>
   ```
   The CLI decodes the blob, verifies it can reach harbour with the API key, and writes an entry to `~/.harbour/runners.json`.
4. Schedule polling the same way as local agents: `npm run harbour -- agent install` (macOS / launchd).

The blob contains the agent's API key — treat it like a password. If it's ever lost or leaked, open the agent detail page, click the **Connect Remote Runner** button, and generate a new command (rotates the key).

**Two caveats worth knowing:**
- **Reachability.** The remote machine must be able to reach harbour at the URL embedded in the blob. Tailscale or any private-mesh tool works well for home setups; otherwise expose harbour behind whatever you normally use for remote HTTP.
- **Workflow scripts run locally.** If the agent's jobs use a workflow gate (shell command), that script must live at `~/.harbour/workflows/` on the remote machine, not on the harbour server. Keep the scripts in a git repo and sync as you would any other dotfile.

Remote runners skip the agentless workflow-only poll (`/api/workflows/next`) — those jobs stay with whichever runner is co-located with the harbour server.

### External Agents

Any tool that can poll an HTTP endpoint works — [OpenClaw](https://openclaw.ai), custom scripts, or any agent framework.

1. Dashboard → **New Agent** → select **External** to get an API key
2. Create a job with a schedule and instructions
3. Copy the invite text into your agent's system prompt

The invite includes credentials and the polling loop. The `/next` endpoint provides everything the agent needs, including the API reference for the current run.

## Admin API Keys

Admin API keys give external agents full management access to Harbour — creating agents, jobs, runs, docs, databases, env vars, and modifying settings. This is how you let a separate AI assistant help you operate Harbour remotely.

1. Dashboard → **Settings** → **Admin API Keys** → **New Key**
2. Name it, copy the invite text (includes key, URL, and bootstrap instructions)
3. Paste the invite into your management agent's conversation

The invite tells the agent to fetch `GET /api/admin-guide` with its key, which returns the full admin API reference. Admin keys resolve to the creating user's identity for audit trails.

Admin API documentation is served at `/api/admin-guide` and maintained in [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

## Agent API

```
GET  /api/agents/:id/next           — get next agent run (or nothing)
GET  /api/agents/:id/next?peek=true — check for work without claiming it
GET  /api/workflows/next            — get next agentless workflow run (runner only)
POST /api/jobs                      — create a workflow-only job (no agent)
PUT  /api/runs/:id/status           — update run status
POST /api/runs/:id/activity         — add to the run's activity log
POST /api/runs/:id/retry            — retry a failed/skipped/killed run
POST /api/runs/:id/kill             — kill a running harbour-agent run
DELETE /api/runs/:id                — delete a run and its attachments
POST /api/runs/:id/attachments      — upload a file or attach an embed URL
GET  /api/runs/:id/attachments/:aid/file — download an uploaded file
POST /api/docs                      — create a doc
PUT  /api/docs/:id                  — update a doc
POST /api/databases                 — create a database
POST /api/databases/:id/rows        — insert rows
GET  /api/databases/:id/rows        — read rows (paginated)
GET  /api/guide                     — full API guide
```

Full API documentation is served at `/api/guide` and maintained in [GUIDE.md](GUIDE.md).

## Run Lifecycle

```
scheduled → running → done
                    → failed
                    → killed (harbour agent stopped mid-run)
                    → skipped (workflow determined nothing to do)
                    → waiting (needs human) → pending (human responded) → running → ...
```

Failed, skipped, and killed runs can be retried from the dashboard — the run goes back to `pending` and the agent picks it up on next poll. Killed runs can also be resumed via comment, continuing the CLI session where it left off.

## Workflows

Workflows bring deterministic, shell-based execution to Harbour jobs. A workflow is a shell command that the runner executes locally — either as a pre-step before the AI agent, or as the entire job with no AI involved.

**Three execution modes:**

| Mode | Config | What happens |
|------|--------|-------------|
| Agent only | No workflow command | Agent runs as normal |
| Workflow + Agent | Workflow command, workflow_only off | Workflow runs first as a gate. Exit 0 = agent runs with stdout as context. Exit 77 = skip. Other = fail. |
| Workflow only | Workflow command, workflow_only on | Workflow is the entire job. No agent, no LLM. Exit 0 = done. Exit 77 = skip. Other = fail. |

Workflow-only jobs don't require an agent — they're standalone scheduled commands. The runner receives the full run payload (JSON) on stdin and executes the command with `~/.harbour/workflows/` as the working directory.

```bash
# Example: workflow-only job that checks an API
# workflow_command: python3 check_health.py
# Receives run payload on stdin, prints result to stdout
```

## Projects

Projects are an optional way to organize your work. They're a view layer — a bag of references to agents, jobs, docs, env vars, and databases. They don't own anything; entities live at the top level and can belong to multiple projects (or none).

- Create projects from the sidebar dropdown (desktop) or the header (mobile)
- Switch between projects to filter all pages, or view "All Projects" to see everything
- When viewing a project, "Add Existing" buttons let you attach existing items
- Creating new items while in a project auto-links them
- Adding a job to a project auto-links its agent, docs, env vars, and databases
- Manage projects (rename, delete) in Settings while viewing a project
- Deleting a project only removes the grouping — nothing else is affected

## Captain

![Captain](public/screenshot-captain.png)

**Captain** is an in-browser chat with a CLI tool (Claude Code, Codex, or Gemini CLI) that runs server-side and streams output back over SSE — your operator's console for the harbour itself. Ask it to summarize what ran today, query the database, debug a stuck job, or set up a new agent without leaving the dashboard.

- Multi-conversation with session continuity. Stop a response mid-stream; old conversations stay resumable.
- Tool calls render as collapsible blocks alongside the assistant's text so you can see what was actually run.
- Workspace at `~/.harbour/captain/` is auto-provisioned on first use with a `CLAUDE.md` describing Harbour's schema, API endpoints, and key paths. `AGENTS.md` and `GEMINI.md` symlink to the same file so all three CLIs share one knowledge base — and you can customize it (Captain never overwrites).
- Pick CLI tool, model, thinking/effort level, and override the working directory in **Settings**.

## Dashboard

- **Captain** — in-browser chat with a local CLI tool (see above) for managing the harbour.
- **Runs** — running, scheduled, waiting, pending, and recent runs. Create one-off runs or recurring jobs from a unified dialog.
- **Jobs** — split into Agent Jobs and Workflow Jobs. Shows run/skip counts, schedules, and linked docs/env vars.
- **Agents** — list of agents with jobs, activity, and poll status. Harbour agents show CLI tool, model, and thinking level.
- **Docs** — shared knowledge base, editable by humans and agents. Pin docs to auto-attach to all new jobs.
- **Databases** — read-only view of agent-managed SQLite tables.
- **Env Vars** — encrypted variables (API keys, tokens) injected at runtime. Pin to auto-attach to all new jobs.
- **Settings** — system timezone, signup control, project management, Captain configuration, and admin API keys.

Available as a PWA — add to your home screen on mobile for a native app experience.

## Documentation

Long-form docs live in [`docs/`](docs/). The index ([docs/README.md](docs/README.md)) groups them into:

- **Concepts** — [agents](docs/concepts/agents.md), [jobs and runs](docs/concepts/jobs-and-runs.md), [workflows](docs/concepts/workflows.md), [projects](docs/concepts/projects.md), [shared context](docs/concepts/shared-context.md), [Captain](docs/concepts/captain.md), [attachments](docs/concepts/attachments.md)
- **Guides** — [getting started](docs/guides/getting-started.md), [running on a different machine](docs/guides/run-on-different-machine.md), [deploying to production](docs/guides/deploy-to-production.md)
- **Reference** — [architecture](docs/reference/architecture.md), [database schema](docs/reference/database-schema.md), [API overview](docs/reference/api.md)

The two wire-contract documents are [GUIDE.md](GUIDE.md) (agent-facing, served at `/api/guide`) and [ADMIN_GUIDE.md](ADMIN_GUIDE.md) (admin-agent-facing, served at `/api/admin-guide`). Those are the source of truth for what's on the wire.

## Tech Stack

Next.js (App Router), SQLite (better-sqlite3), Tailwind / shadcn/ui, TypeScript. Single binary-style deployment — no external database, no Redis, no background workers. Just `npm start`.

## Environment Variables

All Harbour state lives under `~/.harbour` by default — DB, uploads, encryption key, runner config. Back up that directory and you have a snapshot of everything.

| Variable | Description | Default |
|----------|-------------|---------|
| `HARBOUR_HOME` | Root directory for all Harbour state | `~/.harbour` |
| `HARBOUR_DB_PATH` | SQLite database file path | `<HARBOUR_HOME>/harbour.db` |
| `HARBOUR_UPLOADS_DIR` | Run attachments directory | `<HARBOUR_HOME>/uploads` |
| `HARBOUR_ENCRYPTION_KEY` | 64-char hex key for env var encryption | Auto-generated at `<HARBOUR_HOME>/encryption.key` |
| `HARBOUR_MAX_UPLOAD_MB` | Per-file upload cap in MB | `500` |

## License

[MIT](LICENSE)
