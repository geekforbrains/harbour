# Running a runner on a different machine

The harbour server and the runner that polls for work do not have to live on the same box. This guide walks through pointing a runner on machine B at a harbour server on machine A.

## Why you'd want this

The runner is the thing that actually spawns the CLI tool (Claude Code, Codex, Gemini) and runs your workflow scripts. The CLI runs as a subprocess on the runner's host. Anything that depends on the local environment lives with the runner, not the server:

- **iOS / Xcode builds** need a Mac. The harbour server can sit on a Linux box; the runner sits on the Mac.
- **GPU jobs** need the machine with the GPU. Co-locate the runner there.
- **On-prem repos / VPN-only services** can't be reached from a public harbour. Put the runner inside the network and let it reach out.
- **Big working directories.** A runner cloning a 10 GB monorepo into `~/.harbour/agents/<name>` does not need to clone it onto the harbour server.

The agent record itself (jobs, schedule, prompt, model, docs, env vars) lives on harbour. Only the execution moves.

## Reachability

The remote machine must be able to reach the harbour URL embedded in the connect blob. The runner makes outbound HTTP requests; harbour never calls the runner. So this is about the runner reaching harbour, nothing more.

The two patterns that work in practice:

- **Tailscale (or any private mesh).** Run harbour on `harbour.tailnet.example`, list it as the URL when you create the remote agent, and the runner reaches it through the tailnet from anywhere.
- **Public HTTPS.** Run harbour behind a reverse proxy with TLS (see [Deploying to production](deploy-to-production.md)). The runner curls the public URL like any other client.

> If the runner can't reach the URL in the blob, `harbour agent connect` will fail at the verification step (it tries `GET /api/agents/:id/next?peek=true` before writing config). Fix the network before re-running.

## Setup

### 1. Create the agent in harbour

In the dashboard:

1. **Agents → New Agent → Harbour Agent**.
2. Pick a CLI tool (Claude Code, Codex, or Gemini).
3. Name it, pick a default model and thinking level if relevant.
4. Tick **Run on a different machine**.
5. **Create**.

The dialog flips to a success state and shows a one-liner like:

```bash
harbour agent connect <long-base64-blob>
```

Copy that — you'll paste it on the remote machine.

> The blob contains the agent's API key. Treat it like a password. If it leaks, regenerate it from the agent's detail page (see [Rotating the connect blob](#rotating-the-connect-blob) below) — that rotates the key and invalidates the old one.

Because you ticked the remote box, harbour skipped writing a local runner config for this agent. Confirmed in [`src/app/api/agents/route.ts`](../../src/app/api/agents/route.ts) — the `if (type === "harbour" && !remote)` branch is the one that writes `~/.harbour/runners.json` on the server, and remote agents take the other branch.

### 2. Clone harbour on the remote machine

You don't need to build or run the harbour server on the remote — just the `bin/` runner code and its (zero) dependencies.

```bash
git clone https://github.com/geekforbrains/harbour.git
cd harbour
npm install
```

`npm install` is needed because the runner's CLI entry point lives at `bin/harbour.mjs` and is invoked through `npm run harbour --`. The runner itself only uses Node stdlib (see [`Dockerfile.runner`](../../Dockerfile.runner) — a minimal image with no `npm install` required).

### 3. Paste the connect command

```bash
npm run harbour -- agent connect <blob>
```

What this does, traced through [`bin/lib/connect.mjs`](../../bin/lib/connect.mjs):

1. **Decode.** The blob is `btoa(JSON.stringify({ url, agentId, apiKey, name, cli, model, thinking }))`. The CLI base64-decodes and JSON-parses it. Missing required fields fail fast.
2. **Verify.** It calls `GET <url>/api/agents/<agentId>/next?peek=true` with the decoded API key. A 401/403 means the key is bad; any other non-200 means the URL is wrong or harbour is down.
3. **Write.** On success, it appends (or replaces, keyed by `agentId`) an entry in `~/.harbour/runners.json`:

   ```json
   {
     "runners": [
       {
         "agentId": "...",
         "name": "iOS Builder",
         "apiKey": "hbr_...",
         "cli": "claude",
         "model": "sonnet",
         "thinking": null,
         "url": "https://harbour.tailnet.example"
       }
     ]
   }
   ```

If you have multiple remote agents (e.g. one per project), run `harbour agent connect` once per agent — each one appends its own entry.

### 4. Run a poll cycle by hand to confirm

```bash
npm run harbour -- agent run
```

You should see something like `[<agent-name>] Polling...` followed by `[<agent-name>] Nothing to do.` — that's success. If the runner reports a poll error, fix it before scheduling.

### 5. Schedule polling

```bash
npm run harbour -- agent install
```

This writes a launchd plist at `~/Library/LaunchAgents/com.harbour.agent-runner.plist` with `StartInterval=60`. launchd reruns `harbour agent run` every 60 seconds. Logs go to `~/.harbour/runner.log` and `~/.harbour/runner.err.log`.

> **macOS only.** [`bin/lib/install.mjs`](../../bin/lib/install.mjs) writes a launchd plist with no platform check — on Linux it'll silently put a file in the wrong place and the `launchctl load` will fail. There is no built-in Linux/systemd path in `bin/` today. On Linux, write your own systemd unit (see the [DigitalOcean cloud-init template](../../terraform/cloud-init.yml.tftpl) — it's the model: a `bash -c 'while true; do node bin/harbour.mjs agent run || true; sleep 60; done'` service unit), or use cron. The harbour server's [DigitalOcean deploy](deploy-to-production.md#path-b-digitalocean-droplet-via-terraform) does this for the server-side runner.

## What runs on the remote, what runs on harbour

The split is straightforward but worth being explicit about.

**On the remote machine:**

- The runner process itself.
- The CLI tool subprocess — Claude Code, Codex, or Gemini, whichever you picked.
- Working directories at `~/.harbour/agents/<slugified-name>/` — this is where the CLI's `cwd` lives. Clone repos here.
- **Workflow gate scripts.** If a job uses a workflow command (a shell command that runs as a gate before the LLM, see [Workflows](../concepts/workflows.md) when that page lands), the script must exist at `~/.harbour/workflows/` on the **remote**, not on the harbour server. The runner cd's into that directory and runs the command there. Recommendation: keep `~/.harbour/workflows/` in a git repo and sync it across machines like any other dotfile.
- Anything env vars and API keys reference. Env vars are decrypted by harbour and sent in the `/next` payload, so the runner has the plaintext at run time — but the *services* those keys point at must be reachable from the remote.

**On the harbour server:**

- The agent record, jobs, schedules, docs, env vars (encrypted), and run history.
- The encryption key at `<HARBOUR_HOME>/encryption.key`.
- Database (`harbour.db`) and uploads.

## Agentless workflow jobs and remote runners

Workflow-only jobs (no agent — just a shell command on a schedule, see the README's Workflows section) are picked up via `GET /api/workflows/next`. **The remote runner skips this endpoint.** Confirmed in [`bin/lib/runner.mjs`](../../bin/lib/runner.mjs) at `runAgents()`: it only polls `/api/workflows/next` if at least one configured runner has a `localhost`/`127.0.0.1` URL — i.e. the harbour server is on this same machine.

So:

- Agentless workflow-only jobs always run on whichever machine has a runner pointed at `localhost`. Usually that's the harbour server box itself.
- Remote runners pick up only the runs for the specific agents they were connected for.

This is intentional — agentless workflow jobs (cron-style "ping this URL every hour") have no notion of "which machine should this run on", so they stay glued to the harbour server.

## Rotating the connect blob

If the blob leaks, or you forget to copy it before closing the dialog:

1. **Agents → click the agent → Connect Remote Runner**.
2. Click **Generate Command**.
3. Confirm. Harbour rotates the API key and shows a fresh `harbour agent connect <blob>` command.
4. On the remote, paste the new command. `connect` finds the existing entry by `agentId` and replaces it (`bin/lib/connect.mjs`'s `writeRunner` keys on `agentId`).
5. Any previously-connected runner for this agent is now using a stale key and will start getting 401s — re-run `connect` everywhere or delete the stale entries from `~/.harbour/runners.json`.

> The old API key stops working the moment you click **Generate Command**. There's no grace window.

## Sanity checks

If polls aren't producing runs:

- **Did launchd actually load the plist?** `launchctl list | grep com.harbour.agent-runner`.
- **What does the log say?** `tail -f ~/.harbour/runner.log` and `~/.harbour/runner.err.log`.
- **Can the remote actually reach harbour?** `curl -H "Authorization: Bearer <apiKey>" <url>/api/agents/<agentId>/next?peek=true` — if this fails from the remote, no amount of fiddling with the runner will fix it.
- **Are jobs scheduled?** Check the agent's job list in the dashboard. A configured agent with no jobs polls forever and reports "Nothing to do."

## Trying it locally before pointing at a real remote box

The repo includes a Docker Compose `remote` profile that brings up a second container acting as a separate machine, sharing the harbour server's network namespace:

```bash
docker compose --profile remote up -d
```

This brings up `harbour-remote` (defined in [`docker-compose.yml`](../../docker-compose.yml)). The container loops `node bin/harbour.mjs agent run` every 60s and writes its config to `./data-remote/`.

You still have to run `agent connect` inside the container manually after creating the agent in the dashboard:

```bash
docker compose exec harbour-remote node bin/harbour.mjs agent connect <blob>
```

> The blob's URL is whatever your browser was using when you clicked Create — most likely `http://localhost:3030`. Inside the `harbour-remote` container, `localhost` is the container itself, not the harbour server. Edit the blob's URL (or paste a new agent created against `http://harbour:3000`, the compose service hostname) before running `connect`. This is a sandbox for kicking the tires on the connect/poll/run loop, not a substitute for a real second machine.

## Next

- [Deploying to production](deploy-to-production.md) — putting the harbour server somewhere the remote machine can reach.
- [Agents](../concepts/agents.md) — the harbour-vs-external split, the polling loop, and how rotation works.
