# Getting started

The first 30 minutes with Harbour. By the end of this you'll have a server running, a project, an agent, a recurring job, and a verified end-to-end polling loop.

The flow: install and run the server, then drive the claim loop by hand with curl (the way a runner does), then let the bundled local runner do that for you. Setup auto-provisions a local runner, so the hands-off path is just: `setup` → install the runner → it claims work.

> If you want the *why* behind any of this — why polling, why no webhooks, why one run at a time per agent — read [Agents](../concepts/agents.md) and [Jobs and runs](../concepts/jobs-and-runs.md). This page is the *how*.

## Install and run

You'll need **Node 24 LTS** and a working `npm` (macOS or Linux). If you later switch Node versions (e.g. with nvm), re-run `npm rebuild better-sqlite3` so its native binary matches the active Node — otherwise Harbour refuses to boot with a `NODE_MODULE_VERSION` error.

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm ci
npm run build
npm run harbour -- setup   # one-time: create the first user + local runner (interactive)
npm start
```

`harbour setup` does two things: it creates the first user **and** auto-provisions the **local runner** — it registers a `local` runner in the DB and writes its bearer token to `~/.harbour/runner.token` (0600) plus the matching local URL to `~/.harbour/runner.url`. No minting or connect blobs are needed. On macOS it then prompts `Install the runner service to poll for work every 60s? [Y/n]`; on Linux service installation stays explicit through systemd (see [Deploying to production](deploy-to-production.md)).

`npm start` runs the production server at `http://127.0.0.1:14272` by default. It binds only to loopback; put a TLS proxy in front for remote access. For a fresh install on a custom port, export `HARBOUR_PORT` before both setup and start so setup persists the matching runner URL (and the macOS install prompt captures the override):

```bash
export HARBOUR_PORT=18080
npm run harbour -- setup
npm start
```

`PORT=18080 npm start`, `npm start -- --port 18080`, and CLI `--hostname` are server-only compatibility options; after setup, pair them with `HARBOUR_URL` in the runner process/service environment or edit `~/.harbour/runner.url` for a durable change. For a coordinated bind-address change, export `HARBOUR_HOST` for setup and future starts: setup keeps the bundled runner on loopback for wildcard binds and persists a concrete host when one is supplied. Reinstall a macOS runner service after changing environment values captured by its plist.

Open the effective server URL (`http://127.0.0.1:14272` by default, or `http://127.0.0.1:18080` in the custom example), log in, and create your first project from the dashboard — every agent and job lives inside a project. For scripted installs, `npm run harbour -- user create --email <e> --name "<n>" --password <p>` creates the user and provisions the local runner non-interactively; schedule the service separately when ready. Provisioning is idempotent, so a re-run is a no-op once the local runner exists.

State lives in `~/.harbour/` by default — DB at `~/.harbour/harbour.db`, uploads under `~/.harbour/uploads`, encryption key at `~/.harbour/encryption.key`. Back that directory up and you have a snapshot of everything. Override with `HARBOUR_HOME` if you want to keep installs separate.

For active development use `npm run dev`, which defaults to port 3001. Avoid port 14272 — that's reserved for production in this repo's conventions.

## First agent and first job

The dashboard is now up and you have a project. Every agent picks a CLI tool
(Claude Code or Codex) at creation, but the wire contract is plain HTTP — so
this walkthrough drives the claim loop with curl from your terminal, exactly
the way a runner does. (The [bundled runner](#let-the-bundled-runner-do-it)
below does this for you.)

### 1. Create an agent

In the dashboard:

1. **Agents → New Agent** in the top right.
2. Pick Claude Code or Codex (for this curl walkthrough it won't actually be invoked).
3. Name it — `Researcher` is fine.
4. Leave **Placement** as `local` (the host's runner pool).
5. **Create**.

The agent has **no credential of its own**. A runner claims its work and hands the spawned CLI a per-run exec token — that's the contract this walkthrough drives by hand with curl, exactly the way any runner does.

### 2. Create a job

On the agent's detail page, click **New Job**. Fill in:

- **Name** — `Daily check`
- **Schedule** — pick `Every 5 minutes` from the picker
- **Instructions** — `Say hello.`
- **Create**

Behind the dialog this is `POST /api/agents/:id/jobs` with `{"name":"Daily check","schedule":"every 5 minutes","instructions":"Say hello"}`. You can also create jobs over the API directly — see the [management guide](../management-guide.md#create-an-agent-job).

### 3. Verify the polling loop with curl

A runner claims work over the [Runner Protocol](../runner-guide.md), authenticating with a **runner token** (never an agent key — agents have none). `setup` already provisioned the local one — read it into a shell variable:

```bash
export HARBOUR_URL=$(cat ~/.harbour/runner.url)
export RUNNER_TOKEN=$(cat ~/.harbour/runner.token)
```

A runner advertises its **capabilities** — which run kinds and CLIs it can execute, plus the placement labels it serves — and the server hands back the next due unit that matches. Peek first, without claiming (read-only, so call it as often as you like):

```bash
curl -s -X POST -H "Authorization: Bearer $RUNNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"capabilities":{"kinds":["agent","workflow"],"clis":["claude","codex"],"labels":["local"]}}' \
  "$HARBOUR_URL/api/runner/claim?peek=true"
```

Right after creating the job you'll see `{"available":false,...}`, then `{"available":true,...}` once the schedule has fired. To force a run instead of waiting, click the job's **Trigger now** button in the dashboard (no curl auth to set up).

Now claim it for real (drop `?peek=true`):

```bash
curl -s -X POST -H "Authorization: Bearer $RUNNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"capabilities":{"kinds":["agent","workflow"],"clis":["claude","codex"],"labels":["local"]}}' \
  "$HARBOUR_URL/api/runner/claim"
```

You'll get the full bundle: `run`, `job`, `docs`, `tables`, `env`, `attachments`, an **`exec_token`**, and an `api` block with pre-resolved endpoints for this run. The `exec_token` — *not* the runner token — authenticates every callback for this one run.

Finish the run cleanly with the exec token so the next claim doesn't keep returning it:

```bash
RUN_ID=<run.id from the response>
EXEC=<exec_token from the response>
curl -s -X PUT -H "Authorization: Bearer $EXEC" -H "Content-Type: application/json" \
  -d '{"status":"done"}' "$HARBOUR_URL/api/runs/$RUN_ID/status"
```

That's the whole loop. The claim contract is at `GET /api/runner-guide` ([`docs/runner-guide.md`](../runner-guide.md)); what the spawned CLI sees for its run is at `GET /api/guide` ([`docs/guide.md`](../guide.md)).

## Let the bundled runner do it

Section 1 drove the claim loop by hand to show the protocol. In practice the **local runner** (provisioned at setup) does all of it for you — claiming, spawning the CLI, and posting back — for the very same agent. Nothing about the agent changes; you just stop curling and let the runner poll.

### 1. Pick a CLI

Make sure the CLI you want is on your PATH:

- [Claude Code](https://claude.ai/claude-code) — `claude`; complete its normal login or expose `ANTHROPIC_API_KEY` to the runner service
- [Codex](https://github.com/openai/codex) — `codex`; complete its normal login or expose `OPENAI_API_KEY` to the runner service

### 2. Create the agent

The `Researcher` agent from Section 1 already works here — its `local` placement routes its runs to this host's runner pool. If you skipped that section: **Agents → New Agent**, pick the CLI tool, name it, choose a default model and thinking/effort level, leave **Placement** as `local`, **Create**, then add a job (schedule, instructions, **Create**).

There's no per-agent runner config to write — the local runner the setup provisioned claims every agent (and workflow) whose placement belongs on this host, resolving each one's CLI, model, and thinking live from the claim payload (see [`src/app/api/agents/route.ts`](../../src/app/api/agents/route.ts)).

### 3. Run the local runner

The runner is the single process that claims and drains all due work each cycle — agent jobs *and* workflows, running distinct units in parallel. It polls `POST /api/runner/claim` with the local runner token and uses each run's per-run exec token for callbacks.

Before scheduling it, drain once by hand to confirm the CLI is hooked up:

```bash
npm run harbour -- run
```

Output looks like:

```
[Researcher] Starting run <id> (Daily check)
Done — ran 1 unit(s) this cycle.
```

…or `Nothing to do.` when nothing is due. (`Resuming run` instead of `Starting run` if the runner is picking up a killed run via comment.)

Check whether the runner is provisioned and where it points at any time:

```bash
npm run harbour -- status
```

### 4. Schedule polling

On macOS, if you didn't say yes to the install prompt during `setup`, schedule it now:

```bash
npm run harbour -- install
```

This writes a single launchd plist at `~/Library/LaunchAgents/com.harbour.runner.plist` with `StartInterval=60` so launchd reruns `harbour run` every 60 seconds. Logs go to `~/.harbour/runner.log` (stdout) and `~/.harbour/runner.err.log` (stderr).

On Linux, use the runner unit in [Deploying to production](deploy-to-production.md#3-systemd-units); `harbour install` deliberately refuses rather than attempting privileged service setup.

To stop macOS polling: `npm run harbour -- uninstall` (removes the plist after unloading it).

> **The service can't see your shell's PATH.** launchd (and systemd) run the runner under a fixed, minimal PATH — not your interactive shell's. A CLI installed through a version manager (nvm, asdf, pyenv, volta) or reached only via a shell alias won't be found, so its agent runs sit `scheduled` forever with nothing to claim them. The runner advertises only CLIs actually on its PATH — check `harbour status` (what the current shell sees) and **Settings → Runners** (what the service advertised). Fix: add the CLI's directory to the plist's `EnvironmentVariables` (launchd) or the unit's `Environment=PATH=…` (systemd). See [Sanity checks](run-on-different-machine.md#sanity-checks).

## Workflows (deterministic, no agent)

Not all recurring work needs an LLM. A **workflow** is a scheduled shell command — poll an API, sync a file, run a health check — that runs the same way every time, no agent and no tokens. → [Workflows](../concepts/workflows.md).

The one thing to know up front: **the same local runner handles workflows too.** The runner setup provisioned claims agent jobs and workflows alike — so as long as it's installed (or you run `harbour run`), a workflow runs without any extra setup. A workflow only sits in `scheduled` forever if no runner is polling at all.

### 1. Create a workflow

In the dashboard, open **Workflows → New Workflow**. Give it a name and schedule, pick a runtime (`bash`, `python`, or `node`), and write the command body. (Over the API this is `POST /api/jobs` with a `command` gate — see the [management guide](../management-guide.md#create-a-workflow-no-agent).)

### 2. Run it

Nothing new to install — the local runner already claims workflows. Drain once by hand to watch one execute:

```bash
npm run harbour -- run
```

It claims any due workflow run and executes it on the spot, the same cycle that handles agent jobs.

> Running workflows on a **separate** machine — a dedicated workflow host, or one scoped to specific labels — is a later capability via remote enrollment (`harbour connect <blob>` with a minted runner credential). See [Running a runner on a different machine](run-on-different-machine.md).

## Now what?

You have a working harbour with a working agent. From here:

- [Jobs and runs](../concepts/jobs-and-runs.md) — the polling ladder, the lifecycle, how retries work.
- [Agents](../concepts/agents.md) — the harbour-vs-external split and per-agent settings.
- [Workflows](../concepts/workflows.md) — deterministic shell-command jobs and the exit-code contract.
- [Shared context](../concepts/shared-context.md) — docs, tables, env vars, and how pinning pre-selects them for new jobs.
- [Running a runner on a different machine](run-on-different-machine.md) — for iOS/Xcode boxes, GPU workstations, on-prem repos.
- [Local development](local-development.md) — if you're working *on* Harbour: dev server + ports, the validate/rebuild loop, browser review, worktrees.
