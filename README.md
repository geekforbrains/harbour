# Harbour

A control plane for AI agents doing ongoing work.

![Harbour Dashboard](public/screenshot.png)

> I do AI consulting for agencies and busy professionals — helping teams get real, ongoing work out of agents without it becoming a second full-time job. Always happy to hop on a call and figure out how I can be helpful: [gavin@geekforbrains.com](mailto:gavin@geekforbrains.com).

## Why

AI agents can handle real, ongoing responsibilities — marketing, support, dev. They post content, triage tickets, manage campaigns, submit PRs. Most of this runs on recurring schedules.

The problem is visibility. What jobs does each agent have? What ran today? What needs my attention? What broke?

Harbour is the layer underneath your agents — managing what recurring work each has, giving them shared context through docs and data, and surfacing the things that need you.

## How it works

Harbour is polling-based — it never calls out to agents; they pull work on their own schedule.

- **Jobs** are recurring responsibilities: a schedule, instructions, and linked context. When a job fires it creates a **run** — the unit of work that moves through a lifecycle (`scheduled → running → done/failed/…`, with a `waiting → pending` loop when an agent needs a human).
- **Runners** pull work from one endpoint — `POST /api/runner/claim` (the [Runner Protocol](docs/runner-guide.md)) — and get everything bundled: instructions, docs, tables, secrets, and pre-resolved API endpoints. The bundled runner drives Claude Code, Codex, or OpenCode for **agent jobs**; a runner on another machine hooks in over the same protocol.
- **Workflows** are deterministic scheduled shell commands — no agent, no LLM — claimed by the same runner that drives agent jobs. Agent jobs can also define a cheap **prerun** gate that skips a run when there's no work.
- **Shared context** — docs (markdown), tables (agent-managed SQLite tables), and secrets (encrypted env vars) — is linked to jobs and injected into each run.

Work is organized into **projects** — an organizational grouping, not a tenancy boundary. Every user sees everything; a project just keeps one stream of work filterable in the dashboard.

> Going deeper: the [concepts](docs/concepts/) explain the model in prose, and [docs/guide.md](docs/guide.md) is the exact wire contract an agent reads at `/api/guide`.

## Getting started

There's no web signup — the first user is created from the shell (the operator has host access, so first-run setup belongs there). After that, projects and further users are created from the dashboard.

All you need is Node 24 LTS on macOS or Linux.

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm ci
npm run build
npm run harbour -- setup   # one-time: create the first user + local runner (interactive)
npm start                  # run the server
```

`setup` also auto-provisions the **local runner** — it writes its token and local URL under `~/.harbour/`; on macOS it prompts to schedule the polling service. `npm start` runs the server; `npm run harbour -- install` schedules the runner on macOS (polls every 60s), or `npm run harbour -- run` drains all due work once. Linux services are configured with systemd in the production guide.

Visit [http://127.0.0.1:14272](http://127.0.0.1:14272) and log in. Harbour binds to loopback by default; the port and host are configurable as described in [Getting started](docs/guides/getting-started.md#install-and-run). All state (DB, uploads, encryption key) lives in `~/.harbour` — back up that directory and you have everything. (For scripted installs, `npm run harbour -- user create --email <e> --name "<n>" --password <p>` creates the user and provisions the local runner non-interactively.)

### Deploy to production

See [deploying to production](docs/guides/deploy-to-production.md) for the Linux path — systemd units for the server and runner, with Caddy terminating TLS in front. On macOS, the server runs in the foreground by default; `npm run release` handles in-place updates only when a server launch agent has been configured separately.

### Running agents

Built-in support for [Claude Code](https://claude.ai/claude-code), [Codex](https://github.com/openai/codex), and [OpenCode](https://opencode.ai/docs). Create a **Harbour Agent** in the dashboard, and the **local runner** (provisioned at setup) claims and runs it. If you haven't scheduled the runner yet:

```bash
npm run harbour -- install   # macOS launchd; polls every 60s
```

Claude Code and Codex use their normal login or API-key setup on the runner machine. OpenCode is the provider-neutral path: install it (`npm install -g opencode-ai`; Harbour requires OpenCode 1.17.12+), create a reusable project-scoped connection under **LLM Connections**, and select it when creating the agent. Connections support OpenAI, Anthropic, OpenRouter, Ollama, and custom OpenAI-compatible Chat Completions or Responses endpoints. A connection's API key is an encrypted Harbour **Secret**, delivered outside prompt-visible job context and then injected into the OpenCode child process; use a dedicated, budget- and rate-limited provider key because the tool-capable agent can access its process environment. OpenCode models use canonical `provider/model` names such as `openai/gpt-5.6` or `ollama/qwen3-coder`.

To run an agent on **another machine**, give it a `placement` label and run a runner there advertising that label — it claims the agent's runs over the same [Runner Protocol](docs/runner-guide.md) and drives the CLI locally. That remote runner is **self-managed** and needn't be Node: use the standalone [`harbour-agent`](https://github.com/geekforbrains/harbour-agent), your own implementation in any language, or Harbour's bundled runner (enrolled with `harbour connect`). All of them speak the protocol at `/api/runner-guide`; the agent's spawned CLI sees the wire contract at `/api/guide`. Either way the agent has no Harbour API key of its own — the runner token claims and a per-run exec token authenticates the work.

> More: [agents](docs/concepts/agents.md) (CLI auth, OpenCode connections, permissions, model/effort overrides) and [running a runner on a different machine](docs/guides/run-on-different-machine.md).

### Running workflows

Workflows are claimed by the **same** local runner that drives agent jobs — one runner handles both, so there's nothing extra to install. A workflow with no runner scheduled at all just sits queued until the runner is scheduled (launchd on macOS, systemd on Linux) or you run `npm run harbour -- run` (one-shot).

> More: [workflows](docs/concepts/workflows.md) (runners, gates, the exit-code contract).

### Managing Harbour over the API

An **API key** lets a separate management agent operate Harbour itself — create agents, jobs, docs, tables, and more. Mint one in **Settings → API Keys**; the agent fetches its reference at `GET /api/management-guide`. See [docs/management-guide.md](docs/management-guide.md).

## Documentation

Start with the **[docs map](docs/README.md)**, which routes you to the right page. The **[PRD](docs/prd.md)** is the product north star — what Harbour is, the principles it holds to, and the roadmap.

- **Concepts** — [agents](docs/concepts/agents.md), [jobs & runs](docs/concepts/jobs-and-runs.md), [workflows](docs/concepts/workflows.md), [projects](docs/concepts/projects.md), [shared context](docs/concepts/shared-context.md), [attachments](docs/concepts/attachments.md)
- **Guides** — [getting started](docs/guides/getting-started.md), [running on a different machine](docs/guides/run-on-different-machine.md), [deploying to production](docs/guides/deploy-to-production.md)
- **Reference** — [architecture](docs/reference/architecture.md), [database schema](docs/reference/database-schema.md), [API](docs/reference/api.md), [design language](docs/reference/design-language.md)

The wire contracts — [docs/guide.md](docs/guide.md) (worker agents) and [docs/management-guide.md](docs/management-guide.md) (management agents) — are served live and are the source of truth for on-the-wire behavior.

## Tech stack

Next.js (App Router), SQLite (better-sqlite3), Tailwind / shadcn/ui, TypeScript. Single binary-style deployment — no external database, no Redis, no background workers. Just `npm start`.

## Environment variables

All Harbour state lives under `~/.harbour` by default — DB, uploads, encryption key, runner config. Back up that directory and you have a snapshot of everything.

| Variable | Description | Default |
|----------|-------------|---------|
| `HARBOUR_HOME` | Root directory for all Harbour state | `~/.harbour` |
| `HARBOUR_DB_PATH` | SQLite database file path | `<HARBOUR_HOME>/harbour.db` |
| `HARBOUR_UPLOADS_DIR` | Run attachments directory | `<HARBOUR_HOME>/uploads` |
| `HARBOUR_ENCRYPTION_KEY` | 64-char hex key for secret encryption | Auto-generated at `<HARBOUR_HOME>/encryption.key` |
| `HARBOUR_PORT` | Server port; also a bundled-runner local override when set for that process | Production `14272`; development `3001` |
| `PORT` | Next-compatible server port alias (server only; `HARBOUR_PORT` wins) | Production `14272`; development `3001` |
| `HARBOUR_HOST` | `npm start` / `npm run dev` bind address | `127.0.0.1` |
| `HARBOUR_PUBLIC_URL` | Browser-facing base URL for absolute page metadata (set when building) | Effective local server URL |
| `HARBOUR_URL` | Base URL used by the bundled runner (highest precedence) | `HARBOUR_PORT`, saved `runner.url`, then `http://127.0.0.1:14272` |
| `HARBOUR_MAX_UPLOAD_MB` | Per-file upload cap in MB | `500` |
| `HARBOUR_SESSION_TTL_DAYS` | Dashboard session lifetime in days | `30` |

Setup saves its effective runner URL to `~/.harbour/runner.url`. The macOS
installer also captures explicit runner-related environment values in its
launchd plist; reinstall that service after changing them.

## License

[MIT](LICENSE)
