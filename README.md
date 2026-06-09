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
- **Agents** poll `GET /api/agents/:id/next` and get everything bundled: instructions, docs, data, secrets, and pre-resolved API endpoints. An agent is **external** (any HTTP client with an API key) or a **Harbour agent** (a local runner driving Claude Code, Codex, or Gemini).
- **Workflows** are deterministic scheduled shell commands — no agent, no LLM — claimed by separate workflow runners. Agent jobs can also define a cheap **prerun** gate that skips a run when there's no work.
- **Shared context** — docs (markdown), databases (agent-managed SQLite tables), and secrets (encrypted env vars) — is linked to jobs and injected into each run.

It's multi-tenant: an **instance admin** owns the install, and work is organized into **orgs → projects**. Every agent, job, and resource lives inside a project; resources never cross org lines.

> Going deeper: the [concepts](docs/concepts/) explain the model in prose, and [GUIDE.md](GUIDE.md) is the exact wire contract an agent reads at `/api/guide`.

## Getting started

There's no web signup — the first admin is created from the shell (the operator has host access, so first-run setup belongs there). After that, admins create orgs, projects, and users from the dashboard.

### With Docker (recommended)

Only requirement is Docker.

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
make run
```

Create the instance admin (one-time, interactive — runs inside the container):

```bash
docker compose exec harbour node bin/harbour.mjs setup
```

Then visit [http://localhost:3030](http://localhost:3030), log in, and create your first org and project. All state (DB, uploads, encryption key) lives in `./data` — back up that directory and you have everything. `make logs` / `make down` / `make rebuild` / `make clean` manage the container.

### Without Docker

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm install
npm run build
npm run harbour -- setup   # one-time: create the instance admin (interactive)
npm start
```

Visit [http://localhost:3000](http://localhost:3000) and log in. (For scripted installs, `npm run harbour -- admin create --email <e> --name "<n>" --password <p>` creates the admin non-interactively.)

### Deploy to production

Terraform for a single-droplet DigitalOcean deployment (Ubuntu + Caddy + Let's Encrypt, systemd) lives in [`terraform/`](terraform/README.md) — one `terraform apply`. See [deploying to production](docs/guides/deploy-to-production.md) for the full path, and `npm run release` for in-place macOS/launchd updates.

### Running agents

Built-in support for [Claude Code](https://claude.ai/claude-code), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli). Create a **Harbour Agent** in the dashboard (pick a CLI, model, and effort level), then install the local runner:

```bash
npm run harbour -- agent install   # polls every 60s; logs at ~/.harbour/runner.log
```

`agent list` / `agent run` / `agent uninstall` manage it. For an **external** agent, create one to get an API key and paste the invite text into your agent's system prompt — any HTTP poller works.

> More: [agents](docs/concepts/agents.md) (eager polling, per-agent Claude Code permissions, model/effort overrides) and [running a runner on a different machine](docs/guides/run-on-different-machine.md).

### Managing Harbour over the API

An **admin API key** lets a separate management agent operate Harbour itself — create agents, jobs, docs, databases, and more. Mint one in **Settings → Admin API Keys**; the agent fetches its reference at `GET /api/admin-guide`. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

## Captain

![Captain](public/screenshot-captain.png)

**Captain** is an in-browser chat with a server-side CLI tool — your operator's console for the harbour itself. Ask it to summarize today's runs, query the database, debug a stuck job, or set up a new agent without leaving the dashboard. → [more](docs/concepts/captain.md).

## Documentation

Start with the **[docs map](docs/README.md)**, which routes you to the right page. The **[PRD](docs/PRD.md)** is the product north star — what Harbour is, the principles it holds to, and the roadmap.

- **Concepts** — [agents](docs/concepts/agents.md), [jobs & runs](docs/concepts/jobs-and-runs.md), [workflows](docs/workflows.md), [orgs & projects](docs/concepts/projects.md), [shared context](docs/concepts/shared-context.md), [Captain](docs/concepts/captain.md), [attachments](docs/concepts/attachments.md)
- **Guides** — [getting started](docs/guides/getting-started.md), [running on a different machine](docs/guides/run-on-different-machine.md), [deploying to production](docs/guides/deploy-to-production.md)
- **Reference** — [architecture](docs/reference/architecture.md), [database schema](docs/reference/database-schema.md), [API](docs/reference/api.md), [design language](docs/reference/design-language.md)

The wire contracts — [GUIDE.md](GUIDE.md) (worker agents) and [ADMIN_GUIDE.md](ADMIN_GUIDE.md) (admin agents) — are served live and are the source of truth for on-the-wire behavior.

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
| `HARBOUR_MAX_UPLOAD_MB` | Per-file upload cap in MB | `500` |

## License

[MIT](LICENSE)
