# Agents

An agent is the thing that picks up runs and does work. It has a name, a description, an API key, and — for harbour-managed agents — a CLI tool, model, and thinking level. That's the whole shape. Everything else (jobs, schedules, docs, env vars) lives outside the agent and gets attached to runs at poll time.

## The mental model

Every agent in Harbour is one of two kinds:

| Kind | What it is | How it works |
|---|---|---|
| **External** | Any HTTP client with a Bearer token | You bring the runtime. Harbour issues an API key, you write the polling loop, you do the work. |
| **Harbour** | A built-in CLI (Claude Code, Codex, or Gemini CLI) | The local `harbour-runner` launchd job polls Harbour, spawns the CLI subprocess, streams its output back, and posts a final status. |

The wire contract is identical either way. A harbour agent is just an external agent whose runtime happens to ship in this repo. If you replaced the runner with curl + bash you'd get the same observable behavior on Harbour's side.

This is deliberate. Two of Harbour's load-bearing decisions follow from it:

- **Agents pull, Harbour never pushes.** No webhooks, no callbacks, no agent-side HTTP listener required. An agent on a yacht with intermittent Wi-Fi is no different from one running locally — it polls when it can.
- **One run at a time per agent.** Step 1 of `getAgentNextRun` checks for an existing `running` run on this agent and bails out with `null` if there is one. Two parallel polls won't trip over each other; queued work waits its turn. See [Jobs and runs](jobs-and-runs.md) for the polling ladder in full.

## Per-agent settings

Agents are stored in a single `agents` row with these columns (skipping plumbing):

| Column | What it sets |
|---|---|
| `name` | Human label, also used to slugify the harbour workspace dir |
| `description` | Free-form note (shown in the dashboard, not sent to the CLI) |
| `type` | `external` or `harbour` |
| `cli` | `claude`, `codex`, or `gemini` (harbour only) |
| `model` | Default model for this agent (e.g. `sonnet`, `gpt-5-codex`) |
| `thinking` | Default reasoning effort (`low`/`medium`/`high`, or provider-specific) |
| `remote` | `1` if the runner runs on a different machine; harbour skips writing local runner config |
| `api_key_hash` | SHA-256 of the API key — the plaintext is never stored |
| `last_polled_at` | Updated every time `/next` is hit; powers the "active" indicator on the dashboard |

`model` and `thinking` are agent-level **defaults**. A job can override either one for a single job's runs (`payload.job.model || agentModel` in the runner).

## API keys

Each agent gets one API key, format `hbr_<64 hex chars>`. The plaintext is shown once at creation and never again — only the SHA-256 hash is stored. Authentication does the same hash and looks up by `api_key_hash`.

Rotate via `POST /api/agents/:id/rotate-key`. The old key stops working immediately; the new key is shown once. For harbour agents the runner config (in `~/.harbour/runners.json`) holds the plaintext, so a rotation also means re-saving that file — for local agents, deleting and recreating the agent is usually easier; for remote agents, the dashboard's **Connect Remote Runner** panel generates a fresh `harbour agent connect <blob>` command that includes the new key.

## The polling loop

```
GET /api/agents/:id/next            # claim work (state-changing)
GET /api/agents/:id/next?peek=true  # check, no claim
```

The agent posts work back through endpoints baked into the `/next` payload's `api.endpoints` map — no URL construction needed. See [Jobs and runs](jobs-and-runs.md) for the full lifecycle and [GUIDE.md](../../GUIDE.md) for the wire contract.

## Harbour agents

A harbour agent is the same agent record plus `type='harbour'` and a `cli`. When you create one, the dashboard writes an entry to `~/.harbour/runners.json`:

```json
{
  "runners": [
    {
      "agentId": "uuid", "name": "Writer",
      "apiKey": "hbr_...", "cli": "claude",
      "model": "sonnet", "thinking": null,
      "eager": false,
      "url": "http://localhost:3000"
    }
  ]
}
```

`harbour agent run` reads this file and polls every configured agent in parallel (`Promise.allSettled`). `harbour agent install` writes a launchd plist at `~/Library/LaunchAgents/com.harbour.agent-runner.plist` with `StartInterval=60` — every 60 seconds, launchd fires the same `agent run` command. The Docker (`Dockerfile.runner`) and systemd (`harbour-agent-runner.service`) variants use `while true; do … sleep 60; done`, which gives the same effective cadence. Logs land in `~/.harbour/runner.log` and `~/.harbour/runner.err.log`.

For each agent on each tick, the runner:

1. `GET /api/agents/:id/next` — claim a run if one exists.
2. If the run's job has a workflow command, run it (see [Workflows](workflows.md)).
3. Spawn the CLI tool with the prompt — instructions, docs, data, env vars, activity, attachments, and the API cheat-sheet.
4. Stream JSONL output back via `POST /api/runs/:id/output` in 750ms-batched flushes.
5. After the CLI exits, post the final summary as activity. If the agent didn't already set a terminal status, mark the run `failed` (the failsafe).
6. Save or clear the CLI session ID in `~/.harbour/sessions.json` keyed by run ID — used to resume on `waiting` and to allow comment-resume after a kill.

### Eager polling

The `eager` flag on a harbour agent (off by default) changes step 1 into a loop. After a run finishes cleanly — `done`, `waiting`, or `skipped` — the runner immediately re-polls instead of returning to launchd's 60s wait. The loop drains until `/next` returns null (no more queued/scheduled/due work), and then the agent falls back to the normal 60s cadence.

A `failed` or `killed` outcome breaks the loop. Failures are usually transient (network, rate limits, OOM, timeouts), so the 60s gap acts as a free backoff. Kills mean the user explicitly said stop. There's also a hard cap of 50 iterations per launchd tick (`EAGER_MAX_ITERATIONS` in `bin/lib/runner.mjs`) as a safety net against bugs in `getAgentNextRun`.

The flag travels two places: `~/.harbour/runners.json` (cached on the runner host, written by the dashboard for local agents and by `harbour agent connect <blob>` for remote ones), and the `agent.eager` field on every `/next` response payload (read live from the DB). The runner prefers the live value, so toggling Eager from the dashboard takes effect on the next poll without needing to reconnect a remote runner. See `shouldContinueEagerLoop` and `processNextRun` in `bin/lib/runner.mjs` for the decision logic.

### CLI providers

The three built-in CLIs each have their own command shape. From `bin/lib/providers.mjs`:

| CLI | Binary | Key flags | Resume mechanism |
|---|---|---|---|
| Claude Code | `claude` | `-p --output-format stream-json --verbose --include-partial-messages` (plus `--dangerously-skip-permissions` unless the workspace has a valid `.claude/settings.json` — see [Per-agent permissions](#per-agent-permissions-claude-code)) | `--session-id <uuid>` (new) or `--resume <uuid>` |
| Codex | `codex` | `exec --dangerously-bypass-approvals-and-sandbox --json` | `exec resume <thread_id>` |
| Gemini CLI | `gemini` | `--prompt <p> --yolo --skip-trust -o stream-json` | `--resume <session_id>` |

Model selection: Claude uses `--model`, Codex and Gemini use `-m`. Thinking/reasoning depth: Claude uses `--effort <level>`, Codex uses `-c model_reasoning_effort=<level>` (the top-level `--reasoning-effort` flag was removed in Codex 0.128). Gemini dropped its `--thinking` flag in 0.40 — reasoning depth is controlled by model selection now, so the dashboard hides the thinking selector for Gemini agents. The runner picks the per-job override if set, otherwise the agent default; it just passes the string through, so what's accepted depends on the underlying tool.

For Claude only, the runner pre-generates a session UUID before spawning so `PUT /api/runs/:id/session` can record the session ID up front — that lets the dashboard surface the session even while the CLI is still booting.

### Workspaces

Each harbour agent gets a workspace directory at `~/.harbour/workspaces/<slugified-agent-name>/` (created lazily by `ensureWorkingDir`). The runner sets this as the CLI's `cwd`, so all of an agent's runs share filesystem state — checked-out repos, build caches, downloaded fixtures. Two agents have independent workspaces; two **runs** of the same agent share one. If you want isolation between jobs, do that in your job instructions (e.g. `cd /tmp/some-clean-dir && …`), not at the workspace level.

The workspace path defaults to `<HARBOUR_HOME>/workspaces/...` — set `HARBOUR_HOME` to relocate the whole tree. There's no per-agent override; if you want one agent in a different directory, point its job instructions at it.

The runner also layers two workspace-derived things onto each spawn: any job-linked env vars (`payload.env`) are merged into the spawned process environment so the agent's shell can expand `$VAR` natively (rather than the LLM emitting the secret as text), and if the workspace has a `bin/` directory it's prepended to PATH so per-agent wrapper scripts resolve as bare command names. Both behaviors are no-ops when there are no env vars / no `bin/`.

### Per-agent permissions (Claude Code)

By default the runner invokes Claude Code with `--dangerously-skip-permissions` — the permission system can't run interactively under `-p`, and refusing every tool call would deadlock the agent. The flag is the price of headless operation, but it also disables `.claude/settings.json` allow/deny rules entirely.

If a Claude Code agent's workspace contains a valid `.claude/settings.json` — a regular file (not a symlink), non-empty, parseable JSON, with a `permissions` object — the runner drops `--dangerously-skip-permissions` and lets the permission system run. This is the per-agent opt-in: agents without a settings file see the legacy unrestricted behavior, agents with one are scoped to whatever their settings allow.

Detection is conservative on purpose. A symlink to `/dev/null`, a zero-byte placeholder, or a corrupt/half-written JSON file all fall back to the legacy mode rather than silently switching the agent into a less-protected configuration. The probe is in `bin/lib/providers.mjs`.

Effective `settings.json` for headless agents:

- `permissions.defaultMode: "dontAsk"` so unrecognized tool calls are auto-denied. The default `"default"` mode would block waiting for an interactive prompt that has no UI.
- `deny` rules win over `allow` rules — make deny-list mistakes safe.
- `Bash(...)` patterns match the literal command string, so URL filtering inside `curl` is fragile (the URL position depends on flag order). Do argument-level checks in a `PreToolUse` hook under `.claude/hooks/`.

This works well together with the workspace `bin/` PATH injection above: per-agent wrapper scripts (e.g. an `auth-curl` shim that internally reads env vars and execs `curl`) keep `$VAR` references out of the LLM-emitted command, where `dontAsk` mode would otherwise auto-deny them.

Codex and Gemini ship with their own bypass flags (`--dangerously-bypass-approvals-and-sandbox` and `--yolo --skip-trust`); the per-workspace opt-in is Claude-only today.

### Streaming and kill

The runner buffers parsed JSONL events and flushes to `POST /api/runs/:id/output` every 750ms. The dashboard subscribes to `GET /api/runs/:id/output/stream` (SSE) and renders text deltas, tool calls, and tool results live.

Kill is two-tier: when the user clicks **Kill** the server sets `runs.kill_requested_at`. The runner notices via (a) the response of its next `POST /output` call returning `{kill_requested: true}` (~750ms latency while the CLI is streaming), or (b) a fallback `GET /api/runs/:id/kill` poll every 10s for silent stretches. Either path fires an `AbortController` that SIGTERMs the child, waits 3s, then SIGKILLs.

Killed harbour-agent runs save their session ID and post an activity message: "Run killed by user. Comment on this run to resume — the CLI session was saved and the agent will pick back up with full context." Commenting flips the run back to `pending` and the next poll resumes the CLI session.

External agents can't be killed from Harbour — there's no process to signal. `POST /api/runs/:id/kill` returns 400 for `agent_type !== 'harbour'`.

## External agents in practice

For an external agent the polling loop is whatever you want it to be. The reference shape from [GUIDE.md](../../GUIDE.md):

```bash
RESPONSE=$(curl -s -H "Authorization: Bearer $KEY" \
  "$HARBOUR_URL/api/agents/$AGENT_ID/next")
[ -z "$RESPONSE" ] || [ "$RESPONSE" = "null" ] && exit 0
RUN_ID=$(echo "$RESPONSE" | jq -r '.run.id')
# … your runtime … then post status / activity using endpoints in $RESPONSE.api
```

The `api.endpoints` map in the response gives you every URL pre-resolved with this run's ID — `update_status`, `post_activity`, `upload_attachment`, etc. You don't construct paths yourself; you read them out of the payload.

The dashboard shows an "Invite text" you can paste straight into your agent's system prompt. It includes the API key, the `HARBOUR_URL`, the polling endpoint, and the contract for what the agent owes back ("set a final status, post activity, full spec at `/api/guide`"). Treat that text as the agent's onboarding doc.

External agents are scoped — the API key authenticates a single agent and can only mutate that agent's runs. If you want a separate agent that can manage Harbour itself (create agents, edit jobs, attach docs), use an **admin API key** instead. See [`ADMIN_GUIDE.md`](../../ADMIN_GUIDE.md).

## Remote agents

Sometimes a job has to run on a specific machine — Xcode/iOS builds need a Mac, GPU work needs a workstation, scraping behind a residential IP needs a particular box. Mark an agent **remote** at creation and Harbour skips writing local runner config. You then run `harbour agent connect <base64-blob>` on the target machine; the blob carries `{url, agentId, apiKey, cli, name, model, thinking}` and writes the runner entry into the *target's* `~/.harbour/runners.json`.

Two operational notes:

- **Reachability.** The remote machine has to reach the harbour URL embedded in the blob. Tailscale or any private mesh is the common pattern.
- **Workflow scripts are local to the runner.** A workflow command is a shell command that the runner executes; the runner only knows about its own filesystem. Scripts under `~/.harbour/workflows/` need to exist on the remote machine, not on the harbour server. See [Workflows](workflows.md).

The runner also auto-detects whether *any* configured runner points at a localhost URL. If yes, that runner additionally polls `/api/workflows/next` for agentless workflow runs (see [Workflows](workflows.md)). Pure-remote installs skip that poll, since agentless workflow jobs are presumed to belong to the server's box.

## Designing an agent team

The "one run at a time" rule shapes how you scale across projects. Two patterns work:

- **One agent per role** (`Developer`, `Marketer`, `Reviewer`). Jobs queue behind each other on the same agent. Fine when work is bursty or daily.
- **Per-project agents** (`ProjectA Developer`, `ProjectB Developer`). Each agent gets its own workspace, model, prompt context, and queue. Use [Projects](projects.md) to filter the dashboard down to one project at a time so the sidebar doesn't blow out.

Docs, env vars, and databases are all top-level — you can attach the same `Brand Voice` doc and `STRIPE_API_KEY` env var to ten agents' worth of jobs without duplication.

## Source-of-truth pointers

- `src/lib/db/agents.ts` — agent CRUD, API key hashing, rotation.
- `src/lib/db/schema.ts` — the `agents` table and the migrations that added `type`, `cli`, `model`, `thinking`, `remote`.
- `src/app/api/agents/[id]/next/route.ts` — the polling endpoint and the `api.endpoints` builder for run payloads.
- `src/app/api/agents/[id]/rotate-key/route.ts` — key rotation.
- `bin/lib/runner.mjs` — the local runner: poll, spawn, stream, kill, finalize.
- `bin/lib/providers.mjs` — Claude, Codex, and Gemini command builders and JSONL parsers.
- `bin/lib/connect.mjs` — the `harbour agent connect <blob>` flow for remote runners.
