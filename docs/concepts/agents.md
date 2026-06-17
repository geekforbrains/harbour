# Agents

An agent is the thing that picks up runs and does work. It has a name, a description, a [placement](#remote-agents) that routes its runs to a runner, and — for harbour-managed agents — a CLI tool, model, and thinking level. That's the whole shape. Everything else (jobs, schedules, docs, env vars) lives outside the agent and gets attached to runs at claim time.

## The mental model

Every agent in Harbour runs in one of two places, decided entirely by its `placement`:

| Where | What it is | How it works |
|---|---|---|
| **Local** | A built-in CLI (Claude Code, Codex, or Gemini CLI) claimed by the runner on this host | The local `harbour run` launchd job claims work from Harbour, spawns the CLI subprocess, streams its output back, and posts a final status. |
| **Remote** | The same built-in CLI, but pinned to a runner on another machine | The agent's [placement](#remote-agents) names a label; a remote runner you've enrolled for that label claims and drives its runs exactly as the local one does. |

The work a run carries and the callbacks it owes back are identical either way — the only difference is which runner host claims it, decided by the agent's `placement` (see [Remote agents](#remote-agents)).

This is deliberate. Two of Harbour's load-bearing decisions follow from it:

- **Agents pull, Harbour never pushes.** No webhooks, no callbacks, no agent-side HTTP listener required. An agent on a yacht with intermittent Wi-Fi is no different from one running locally — it polls when it can.
- **One run at a time per agent.** The lock is enforced server-side at claim time: a run is claimable only if its agent has nothing in flight (lock unit = `agent_id`, where in-flight = `running | waiting | pending`). Two parallel claims won't trip over each other; queued work waits its turn. See [Jobs and runs](jobs-and-runs.md) for the polling ladder in full.

## Per-agent settings

Agents are stored in a single `agents` row with these columns (skipping plumbing):

| Column | What it sets |
|---|---|
| `name` | Human label (renaming it never changes the slug) |
| `slug` | Creation-time, immutable workspace path segment — see [Workspaces](#workspaces) |
| `description` | Free-form note (shown in the dashboard, not sent to the CLI) |
| `color` | identity hue on the agent's icon (user-selectable, name-hash fallback) |
| `eager` | legacy flag; subsumed by the runner's pool drain (see [Eager](#eager)) — no longer changes runner behavior |
| `cli` | `claude`, `codex`, or `gemini` (harbour only) |
| `model` | Default model for this agent (e.g. `sonnet`, `gpt-5.5`) |
| `thinking` | Default reasoning effort (`low`/`medium`/`high`, or provider-specific) |
| `placement` | Label that routes this agent's runs to a runner — `local` (default) for the host's pool, or a named label served by an enrolled remote runner (see [Remote agents](#remote-agents)) |

`model` and `thinking` are agent-level **defaults**. A job can override either one for a single job's runs — the runner resolves `cli`/`model`/`thinking` live from the claim payload's agent block, with any per-job override winning (`resolveRunConfig` in `bin/lib/providers.mjs`).

## Credentials

An agent has **no credential of its own**. Everything an agent does rides on two tokens that belong to the *runner*, not the agent:

- A **runner token** (`hbrn_…`) claims the agent's runs — identical for a local or a remote runner.
- A per-run **exec token** (`hbx_…`), minted at claim and handed to the spawned CLI, authenticates every callback the run makes — its own lifecycle (status, activity, output, title, attachments) and the agent's writes to shared docs and tables. It's scoped to that one run. Once the run is terminal it can no longer write shared resources (docs/tables reject it), but it stays valid for the run's own lifecycle callbacks so the postrun gate can post a final summary and override `done → failed`.

This is why local and remote agents connect the same way: a runner claims the work and the CLI authenticates *as the run*. There is no long-lived per-agent API key to issue, rotate, or leak — programmatic management of Harbour itself uses an [admin API key](../admin-guide.md) instead.

## Claiming work

A run never reaches a CLI by being addressed directly. The runner claims the next runnable unit:

```
POST /api/runner/claim            # claim work (state-changing)
POST /api/runner/claim?peek=true  # check liveness / availability, no claim
```

The claim response carries the run, its job, the agent's live config, the workspace block, env vars, a per-run `exec_token`, and an `api.endpoints` map of pre-resolved callback URLs — no URL construction needed. Everything the runner posts back goes through those endpoints, authenticated with the `exec_token`. See [Jobs and runs](jobs-and-runs.md) for the full lifecycle, the [Runner Protocol](../runner-guide.md) for the claim contract, and [guide.md](../guide.md) for the CLI-facing wire contract.

## Harbour agents

A harbour agent is the same agent record with a `cli` set — there's no stored `type` flag; a runner-backed agent is simply one that has a CLI configured. Nothing about the agent is cached on disk: the runner discovers it at claim time. One runner host runs **one** command, `harbour run`, which serves every agent (and workflow) whose work it's eligible to claim.

`harbour run` loads the runner's bearer token from `~/.harbour/runner.token` (the only secret on disk, 0600) and a base URL (`HARBOUR_URL` env > `~/.harbour/runner.url` > `http://localhost:3000`), detects what the host can execute (installed CLIs on PATH; `kinds` = `[agent, workflow]` when a CLI is present, else `[workflow]`; `labels` = `[local]`, overridable via `HARBOUR_RUNNER_LABELS`), and POSTs `/api/runner/claim` advertising those capabilities. Each cycle **drains** all currently-due work, running distinct lock units in parallel up to a pool cap (`POOL_SIZE`, default 4, override `HARBOUR_POOL_SIZE`), then exits. It branches on the claimed run's `job.kind`: drive a CLI session for `agent`, run the gate script for `workflow`.

`harbour install` writes a launchd plist at `~/Library/LaunchAgents/com.harbour.runner.plist` with `StartInterval=60` — every 60 seconds, launchd fires `harbour run`. The systemd variant on Linux (see [Deploying to production](../guides/deploy-to-production.md#3-systemd-units)) gives the same effective cadence. Logs land in `~/.harbour/runner.log` and `~/.harbour/runner.err.log`. (The DB `runners` table is the registry; there's no per-agent config file.)

For each agent run it claims, the runner:

1. Reads the agent's live `cli`/`model`/`thinking` from the claim payload (per-job override wins) and resolves the workspace.
2. If the run's job has a prerun command, run it as a gate before invoking the LLM (see [Workflows](workflows.md)).
3. Spawn the CLI tool with the prompt — instructions, docs, data, env vars, activity, attachments, and the API cheat-sheet.
4. Stream JSONL output back via `POST /api/runs/:id/output` in 750ms-batched flushes.
5. After the CLI exits, post the final summary as activity. If the agent didn't already set a terminal status, the harness drives a dedicated finalize turn to set one (forcing `failed` only as a backstop).
6. Save or clear the CLI session ID in `~/.harbour/sessions.json` keyed by run ID — used to resume on `waiting` and to allow comment-resume after a kill.

Every callback above (`/api/runs/:id/*`) is authenticated with the run's per-run `exec_token` from the claim payload — the high-value runner token never reaches the CLI or a gate.

### Eager

Eager is a legacy concept — the runner no longer needs it. Each `harbour run` cycle already drains all currently-due work in parallel up to the pool cap, so there is no per-agent loop to opt into and no 60s gap between back-to-back runs of the same agent within a cycle. The `eager` flag/column still exists on the agent record and is carried on the claim payload, but it does not change runner behavior (its full removal is a later chunk).

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

Each harbour agent gets a workspace directory at `~/.harbour/workspaces/<org-slug>/<project-slug>/<agent-slug>/` (created lazily by `ensureWorkingDir`). The path mirrors the org → project → agent hierarchy, so two agents with the same name in different projects get distinct workspaces. The runner sets this as the CLI's `cwd`, so all of an agent's runs share filesystem state — checked-out repos, build caches, downloaded fixtures. Two agents have independent workspaces; two **runs** of the same agent share one. If you want isolation between jobs, do that in your job instructions (e.g. `cd /tmp/some-clean-dir && …`), not at the workspace level.

Each path segment is a **slug**, assigned at creation from the entity's name (lowercase; runs of anything outside `a-z0-9` collapse to a single `-`; edges trimmed) and **immutable on rename** — renaming an org, project, or agent never moves or orphans a workspace; the folder keeps its creation-time name. Names must be unique per scope ignoring case and punctuation (orgs instance-wide, projects per org, agents per project): "Dev Agent" and "Dev_Agent" produce the same slug, and creating the second is rejected with a clear error. Uniqueness is enforced at creation only, on the slug — after renames, display names may come to duplicate. Archived orgs and projects keep holding their slug, so a later same-name entity can't inherit leftover workspace directories on runner machines. Enforcement details in [database-schema.md](../reference/database-schema.md#slugs).

The runner never derives the path from display names — the claim payload carries a `workspace` block of the three slugs (see [guide.md](../guide.md)), and the runner validates each segment against `^[a-z0-9-]+$`, refusing the run (rather than transforming the path) if any segment is malformed. Against an older server that sends no workspace block, it falls back to the legacy flat `workspaces/<agent>/` layout with a logged warning. Runs paused after the upgrade resume in the cwd pinned in `sessions.json` when they ran, so renames and layout changes never move them; runs already waiting when the runner was upgraded have no pinned cwd and resume in the legacy flat directory derived from the agent's current name — avoid renaming an agent while it has pre-upgrade waiting runs. After upgrading, old flat directories are inert and can be deleted once no waiting/running runs remain. Deleting an org, project, or agent doesn't clean its workspace directories on runner machines either — disk cleanup is manual.

The workspace root defaults to `<HARBOUR_HOME>/workspaces/...` — set `HARBOUR_HOME` to relocate the whole tree. There's no per-agent override; if you want one agent in a different directory, point its job instructions at it.

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

Kill works the same whether the run was claimed by the local pool or a remote runner — both poll the kill signal between flushes. A [remote agent](#remote-agents) on another machine is killed identically; the remote runner driving it picks up the same signal.

## Remote agents

Sometimes a job has to run on a specific machine — Xcode/iOS builds need a Mac, GPU work needs a workstation, scraping behind a residential IP needs a particular box. "Running an agent elsewhere" isn't a separate kind of agent and isn't a self-hosted HTTP poller: it's an ordinary agent whose `placement` names a label, plus a runner you've enrolled on that machine and authorized to serve that label. Work routes by matching a run's placement against the labels a runner advertises (`r.placement IN (runner labels)` in `claimNextRun`), so the right host claims it; everything the run carries and owes back is identical to a local run.

Enrolling one is three steps:

1. **Set the agent's placement.** Give the agent a `placement` label other than `local` — say `gpu` or `mac`. (Workflow jobs carry their own placement; agent jobs inherit the agent's.)
2. **Mint a remote runner.** As an instance admin, hit `POST /api/runners` with `{ name, labels: ["gpu"], scope? }` — or use **Settings → Runners → New Runner**. The response includes a ready-to-paste `npm run harbour -- connect <blob>`, where the base64 blob carries the harbour URL, the runner's bearer token, and its name. An optional `scope` (`{ orgId?, agentId? }`) restricts the token to one org's or one agent's work. `GET /api/runners` lists them; `DELETE /api/runners/:id` revokes (the next claim 401s).
3. **Connect on the remote host.** Run `harbour connect <blob>` there: it peek-verifies the token against `/api/runner/claim?peek=true` and writes `~/.harbour/runner.token` + `runner.url` (0600). Then `harbour install` (or a one-shot `harbour run`) starts the same drain-claim loop, which now claims the `gpu`/`mac` work that local runners can't.

A remote runner advertises its labels via `HARBOUR_RUNNER_LABELS` on the host (the row's `labels` is what the token is *authorized* to serve; the advertised set is intersected with it). One runner credential covers both agent and workflow work — there's no separate per-agent or per-workflow credential.

Those three steps use Harbour's **bundled** runner, but a remote runner is self-managed and can be *any* [Runner Protocol](../runner-guide.md) implementation — the standalone [`harbour-agent`](https://github.com/geekforbrains/harbour-agent) or your own in any language. Only the minted credential (step 2) is required; how a self-managed runner stores its token and polls is its own concern. See [Running a runner on a different machine](../guides/run-on-different-machine.md).

Remote agents are still scoped — a run can only mutate itself. If you want a separate agent that can manage Harbour itself (create agents, edit jobs, attach docs), use an **admin API key** instead. See [`admin-guide.md`](../admin-guide.md). [guide.md](../guide.md) remains the wire contract for the run payload — its shape, the statuses, and what each run owes back — whether a local or remote runner is driving the CLI.

Two operational notes:

- **Reachability.** The remote machine has to reach the harbour URL it's pointed at. Tailscale or any private mesh is the common pattern.
- **Gate runtimes must be installed on the runner.** A prerun/postrun gate is a `{ runtime, content }` script stored in Harbour; the runner materializes its body and runs it via the runtime's interpreter before/after the LLM. Nothing is hand-placed — but the runtime the gate names (`bash`, `python3`, or `node`) must be installed on the runner's machine. See [Workflows](workflows.md).

## Designing an agent team

The "one run at a time" rule shapes how you scale across projects. Two patterns work:

- **One agent per role** (`Developer`, `Marketer`, `Reviewer`). Jobs queue behind each other on the same agent. Fine when work is bursty or daily.
- **Per-project agents** (`ProjectA Developer`, `ProjectB Developer`). Each agent gets its own workspace, model, prompt context, and queue. Use [Projects](projects.md) to filter the dashboard down to one project at a time so the sidebar doesn't blow out.

Docs, secrets, and tables are shared at the **org** level (or scoped to a project), so an org-level `Brand Voice` doc or `STRIPE_API_KEY` secret can serve every project in the org without duplication. See [Shared context](shared-context.md).

## Source-of-truth pointers

- `src/lib/db/agents.ts` — agent CRUD (no per-agent credential; runs are claimed by runners).
- `src/lib/db/schema.ts` — the `agents` table (`project_id`, `slug`, `cli`, `model`, `thinking`, `color`, `eager`, `placement`).
- `src/lib/slug.ts` — the canonical slug algorithm and the name-collision errors.
- `src/app/api/runner/claim/route.ts` — the unified claim endpoint and the `api.endpoints` builder for run payloads.
- `src/lib/db/runs.ts` — `claimNextRun` / `claimableLabels`: placement-to-label routing and remote-token scoping.
- `src/app/api/runners/route.ts` + `[id]/route.ts` — mint (`POST`), list (`GET`), and revoke (`DELETE`) remote runner credentials; `src/lib/db/runners.ts` is the registry.
- `bin/lib/runner.mjs` — the runner: `runPool` (claim, drain, dispatch), then spawn, stream, kill, finalize per run.
- `bin/lib/providers.mjs` — Claude, Codex, and Gemini command builders and JSONL parsers; `detectCapabilities` and `resolveRunConfig`.
- `bin/lib/connect.mjs` — the `harbour connect <blob>` flow for enrolling a remote runner.
