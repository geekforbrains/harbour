# Running a runner on a different machine

The harbour server and the runner that claims work do not have to live on the same box. This guide walks through enrolling a runner on machine B against a harbour server on machine A, and routing specific work to it.

A runner is **any process that implements the [Runner Protocol](../runner-guide.md)** — it needn't be written in Node or be Harbour's bundled runner. Remote runners are **self-managed**: run [`harbour-agent`](https://github.com/geekforbrains/harbour-agent) (the standalone reference runner) or your own implementation in any language. Everything below — placement labels, minting a credential, the claim handshake, the run lifecycle — is protocol-level and works the same regardless of what executes it; only step 3's *bundled-runner* path is Node-specific.

## Why you'd want this

The runner is the thing that actually spawns the CLI tool (Claude Code, Codex, Gemini) and runs your workflow scripts. The CLI runs as a subprocess on the runner's host. Anything that depends on the local environment lives with the runner, not the server:

- **iOS / Xcode builds** need a Mac. The harbour server can sit on a Linux box; the runner sits on the Mac.
- **GPU jobs** need the machine with the GPU. Co-locate the runner there.
- **On-prem repos / VPN-only services** can't be reached from a public harbour. Put the runner inside the network and let it reach out.
- **Big working directories.** A runner cloning a 10 GB monorepo into `~/.harbour/workspaces/<org-slug>/<project-slug>/<agent-slug>/` does not need to clone it onto the harbour server.

The agent record itself (jobs, schedule, prompt, model, docs, env vars) lives on harbour. Only the execution moves. The same runner claims **both** agent runs and workflows — there's no separate workflow runner.

## How the routing works

A runner is the unit of execution, and which work it claims is decided by **placement labels**:

- Every agent and every workflow job has a `placement` label, defaulting to `local`.
- A runner advertises the labels it serves on every claim. The auto-provisioned pool on the harbour host advertises `local`; a remote runner advertises whatever you give it via `HARBOUR_RUNNER_LABELS` (comma-separated) on the host, defaulting to `local` if unset. (The token's minted labels are the authorization ceiling the server enforces — see the next bullet — not the advertised set.)
- Work routes to a runner whose advertised label matches the job's `placement` — and, for a remote-tier token, a label it's *authorized* to serve. A job whose placement no connected runner advertises just sits `scheduled`.

So "run this on another machine" is three moves: give the job a placement label, mint a remote runner authorized for that label, and connect it on the other host. The claim filters are detailed in [architecture](../reference/architecture.md).

**One runner, many agents.** A runner isn't tied to an agent — it claims by label. Point several agents at the same label and a single runner serving it runs them all; their schedules and targeting stay on harbour, and because the claim lock is per-`agent_id`, their runs proceed in parallel up to the runner's pool size. You need a second runner only for a *different machine* or hard isolation — never just because you've added another agent. See [Designing an agent team](../concepts/agents.md#designing-an-agent-team).

## Reachability

The remote machine must be able to reach the harbour URL embedded in the connect blob. The runner makes outbound HTTP requests; harbour never calls the runner. So this is about the runner reaching harbour, nothing more.

The two patterns that work in practice:

- **Tailscale (or any private mesh).** Run harbour on `harbour.tailnet.example`, and mint the runner against that URL so the connect blob carries it. The runner reaches harbour through the tailnet from anywhere.
- **Public HTTPS.** Run harbour behind a reverse proxy with TLS (see [Deploying to production](deploy-to-production.md)). The runner curls the public URL like any other client.

> If the runner can't reach the URL in the blob, `harbour connect` fails at the verification step — it does a `POST /api/runner/claim?peek=true` with the token before writing any config. Fix the network before re-running.

## Setup

### 1. Point the work at a placement label

Pick a label for the machine — say `gpu` or `mac-builder`.

- **Workflow job:** set its **Placement** field to that label when you create it (the create dialog has a Placement input; default `local`).
- **Agent:** set the agent's `placement` to that label. Every run the agent's jobs produce inherits it. (PATCH `/api/agents/:id` with `{ "placement": "gpu" }`; see the [API reference](../reference/api.md).)

A "remote" agent is simply an agent whose placement points at a label only a remote runner serves — there's no separate API-key poller and no "runs on a different machine" toggle anymore. The agent record still lives on harbour; only where it executes changes.

### 2. Mint a remote runner authorized for that label

An instance admin mints a runner credential. Either:

**In the dashboard:** **Settings → Runners → New Runner**. Give it a name and the labels it should serve (e.g. `gpu`). Harbour shows a ready-to-paste connect command.

**Over the API:**

```bash
curl -X POST https://harbour.tailnet.example/api/runners \
  -H "Authorization: Bearer <admin-session-or-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Mac builder", "labels": ["gpu"]}'
```

The response includes the runner row plus a `connect` field:

```bash
npm run harbour-agent -- connect <long-base64-blob>
```

The minted command targets the standalone [`harbour-agent`](https://github.com/geekforbrains/harbour-agent) runner (the self-managed path in step 3). If you instead run Harbour's bundled runner from a checkout, swap `harbour-agent` → `harbour`: `npm run harbour -- connect <blob>`.

Traced through [`src/app/api/runners/route.ts`](../../src/app/api/runners/route.ts), the blob is `base64(JSON.stringify({ url, token, name }))` — the harbour URL, the runner's bearer token (`hbrn_…`), and a friendly name. The token is the only secret in it; treat the blob like a password. You can also pass an optional `scope` (`{ orgId?, agentId? }`) to restrict the token to one org's or one agent's work.

`GET /api/runners` lists every runner; `DELETE /api/runners/:id` revokes one.

> The token is minted once and only its hash is stored. If you lose the blob before pasting it, you can't recover the token — revoke the runner and mint a new one (see [Rotating a runner token](#rotating-a-runner-token)).

### 3. Run a runner on the remote machine

The minted token from step 2 is all a runner needs. Two paths:

**A self-managed runner** — [`harbour-agent`](https://github.com/geekforbrains/harbour-agent) or your own implementation in any language. Point it at the harbour URL with that token, have it advertise the label, and it claims over the [Runner Protocol](../runner-guide.md) like any other runner. Follow that project's own setup; the bundled-runner steps below (4–6) are Harbour's Node CLI and don't apply.

**Harbour's bundled runner** (the rest of this guide) — the Node runner from this repo, run on the remote box. You don't build or run the harbour *server* there, just the `bin/` runner. It needs **Node 24 LTS** (this repo pins it):

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm install
```

`npm install` is needed because the runner's CLI entry point lives at `bin/harbour.mjs`, invoked through `npm run harbour --`. The runner itself only uses Node stdlib — everything under `bin/` runs with zero installed dependencies.

### 4. Connect the runner

```bash
npm run harbour -- connect <blob>
```

What this does, traced through [`bin/lib/connect.mjs`](../../bin/lib/connect.mjs):

1. **Decode.** The blob is base64-decoded and JSON-parsed; missing `url`, `token`, or `name` fails fast.
2. **Verify.** It calls `POST <url>/api/runner/claim?peek=true` with the token, advertising this host's detected capabilities. A 401/403 means the token is bad or revoked; any other non-200 means the URL is wrong or harbour is down.
3. **Write.** On success it saves the token to `~/.harbour/runner.token` (0600, like the encryption key) and the URL to `~/.harbour/runner.url`. The URL can be overridden at runtime by `HARBOUR_URL`.

One runner credential per host — connecting again overwrites the saved token and URL.

### 5. Advertise the right labels and run a cycle by hand

The token was minted authorized for `gpu`, but the runner still has to *advertise* `gpu` on each claim. Set `HARBOUR_RUNNER_LABELS` so it does (otherwise it advertises only `local`):

```bash
export HARBOUR_RUNNER_LABELS=gpu
npm run harbour -- run
```

`harbour run` claims and drains everything currently due that this runner is eligible for, then exits. With nothing due you'll see it claim nothing and stop — that's success. If it reports a claim error, fix it before scheduling.

> Check provisioning any time with `npm run harbour -- status` — it prints whether a token is present and which URL it resolves.

### 6. Schedule polling

```bash
npm run harbour -- install
```

This writes a launchd plist at `~/Library/LaunchAgents/com.harbour.runner.plist` with `StartInterval=60`. launchd reruns `harbour run` every 60 seconds. Logs go to `~/.harbour/runner.log` and `~/.harbour/runner.err.log`.

The plist captures the current environment's `PATH` and `HOME`, but **not** arbitrary exports — so put `HARBOUR_RUNNER_LABELS` (and `HARBOUR_URL` if you use it) somewhere the launchd session inherits, e.g. the host's login environment, or edit the plist's `EnvironmentVariables` block by hand after install.

> **macOS only.** [`bin/lib/install.mjs`](../../bin/lib/install.mjs) writes a launchd plist with no platform check — on Linux it'll silently put a file in the wrong place and the `launchctl load` will fail. There is no built-in Linux/systemd path in `bin/` today. On Linux, write your own systemd unit — the runner unit in [Deploying to production](deploy-to-production.md#3-systemd-units) is the model: a `bash -c 'while true; do node bin/harbour.mjs run || true; sleep 60; done'` service with `HARBOUR_RUNNER_LABELS` in its `Environment=` — or use cron.

## What runs on the remote, what runs on harbour

The split is straightforward but worth being explicit about.

**On the remote machine:**

- The runner process itself.
- The CLI tool subprocess — Claude Code, Codex, or Gemini, whichever the agent picked.
- Working directories at `~/.harbour/workspaces/<org-slug>/<project-slug>/<agent-slug>/` — this is where the CLI's `cwd` lives. Clone repos here. (See [agents](../concepts/agents.md) for how the path is derived.)
- **Gate runtimes.** Prerun/postrun gate scripts are `{ runtime, content }` gists stored in Harbour; the runner materializes each body into `~/.harbour/workflows/<scripts_dir>` from the claim payload and runs it there — nothing to hand-place or sync. You only need the gate's **runtime** installed on the remote: `bash`, `python3`, or `node`, depending on which the gate uses.
- Anything env vars and API keys reference. Env vars are decrypted by harbour and sent in the claim payload, so the runner has the plaintext at run time — but the *services* those keys point at must be reachable from the remote.

**On the harbour server:**

- The agent record, jobs, schedules, docs, env vars (encrypted), and run history.
- The encryption key at `<HARBOUR_HOME>/encryption.key`.
- Database (`harbour.db`) and uploads.

## Rotating a runner token

The runner token is a bearer credential. There's no in-place rotation — you revoke and re-mint:

1. **Settings → Runners**, find the runner, and **Delete** it (or `DELETE /api/runners/:id`). Deleting the row invalidates its token immediately — the runner's next claim gets a 401.
2. Mint a fresh runner with the same labels (**New Runner**, or `POST /api/runners`).
3. On the remote, paste the new connect command. `harbour connect` overwrites the saved token and URL.

> The old token stops working the moment you delete the runner. There's no grace window — connect the replacement before (or right after) revoking if you can't tolerate a gap.

## Sanity checks

If polls aren't producing runs:

- **Did launchd actually load the plist?** `launchctl list | grep com.harbour.runner`.
- **What does the log say?** `tail -f ~/.harbour/runner.log` and `~/.harbour/runner.err.log`.
- **Can the remote actually reach harbour?** `curl -X POST -H "Authorization: Bearer $(cat ~/.harbour/runner.token)" -H "Content-Type: application/json" -d '{"capabilities":{"kinds":["workflow"],"clis":[],"labels":["gpu"]}}' "$(cat ~/.harbour/runner.url)/api/runner/claim?peek=true"` — if this fails from the remote, no amount of fiddling with the runner will fix it.
- **Do the labels line up?** The job's `placement` must match a label the runner *advertises* (`HARBOUR_RUNNER_LABELS`) **and** a label its token was *authorized* for at mint time. A mismatch leaves the work `scheduled` with nothing to claim it. Confirm the runner's advertised labels and last poll under **Settings → Runners**.
- **Are jobs scheduled?** Check the agent's job list in the dashboard. A configured agent with no jobs polls forever and claims nothing.
- **Does the service see the CLI?** A launchd/systemd service runs under a **fixed, minimal PATH — not your interactive shell's**. A CLI installed via a version manager (nvm, asdf, pyenv, volta) or exposed only through a shell alias is invisible to the service even though it works in your terminal. The runner advertises only CLIs it finds on PATH, so a missing one leaves that agent's runs `scheduled` with no runner to claim them (surfaced as an absent capability under **Settings → Runners**). `harbour status` prints the CLIs the *current shell* sees; the registry shows what the service actually advertised. Fix it by adding the CLI's directory to the service's PATH — `EnvironmentVariables` in the launchd plist, or `Environment=PATH=...` in the systemd unit — or install the CLI somewhere already on that PATH.

## Next

- [Deploying to production](deploy-to-production.md) — putting the harbour server somewhere the remote machine can reach.
- [Agents](../concepts/agents.md) — the polling loop, placement, and how a run is claimed.
- [Workflows](../concepts/workflows.md) — deterministic jobs claimed by the same runner.
