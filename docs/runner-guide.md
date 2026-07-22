# Runner Protocol

The contract any runner implements to execute Harbour work. This page is the
**source of truth for on-the-wire behavior** and is served live at
`/api/runner-guide`. The runner Harbour ships (`harbour run`) is just the first
implementation; it has no privileged path a third-party runner couldn't take.

Harbour is the **control plane** (source of truth, queue, lifecycle, the dashboard).
A runner is the **execution plane**: it asks "what's next?", runs it, reports
progress, finalizes. A runner knows nothing about projects — execution is
project-agnostic; the project appears only as a workspace path segment the
server hands over pre-resolved.

## Identity

A runner authenticates with a bearer token (`hbrn_…`) on the `Authorization`
header. There are two tiers — the **same protocol**, different trust:

| | Local | Remote |
|---|---|---|
| Trust | trusted, **unscoped** — claims any `placement = local` work across every project | **scoped** — claims only work matching its authorized labels (+ an optional single-agent scope) |
| Token | `~/.harbour/runner.token` (0600), auto-provisioned at setup | minted by an operator, held on the runner's own host |

The local token can read every project's decrypted secrets (run payloads carry job
Secrets and may carry an OpenCode connection key in a private runtime block).
The runner and spawned tool-capable agents are a trusted execution plane, so the
host is the trust boundary. Treat it like the DB and encryption key: local only,
never shipped off-box.

## Capabilities

On **every** claim the runner advertises what it can run, so the server only
hands it work it can execute:

```json
{
  "kinds":  ["agent", "workflow"],   // run kinds this runner executes
  "clis":   ["claude", "codex", "opencode"], // installed executors this runner implements
  "labels": ["local"]                // placement labels this runner serves
}
```

The bundled runner detects these from the host (installed CLIs + shell) and
advertises `labels: ["local"]`. A remote runner advertises whatever
`HARBOUR_RUNNER_LABELS` gives it (comma-separated, default `["local"]`); its
authorized labels — and an optional `{ agentId }` scope pinning the token to one
agent's work — are the ceiling the server enforces on what it may claim, not
what it advertises. (An agent-scoped token never claims workflow jobs — they
have no agent.) **Capability honesty:** the server never assumes a CLI is
present — an agent run is handed out only if the agent's CLI is in `clis`.
For OpenCode, the bundled runner additionally requires version 1.17.12 or newer;
older or unparsable versions are not advertised because Harbour depends on its
complete `run --dir --pure --auto` and project-config control surface.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runner/claim` | Claim the next runnable unit. Body: `{ "capabilities": {…} }`. `?peek=true` checks liveness/availability without claiming. |
| `POST` | `/api/runs/:id/output` | Append captured CLI output (agent runs). Response piggybacks `{ kill_requested }`. |
| `POST` | `/api/runs/:id/activity` | Append a progress breadcrumb / captured output. |
| `PUT`  | `/api/runs/:id/status` | Drive the lifecycle: `done`/`failed`/`skipped`/`killed`, plus `waiting` for agent runs. (`pending` is human-set — the exec token can't set it.) |
| `PUT`  | `/api/runs/:id/title` | Set a short run title (agent runs). |
| `PUT`  | `/api/runs/:id/session` | Save the CLI session id (+ cwd) so a killed/waiting run resumes in place. |
| `GET`  | `/api/runs/:id/kill` | Poll the advisory kill flag; stop the child when set. |
| `POST` | `/api/runs/:id/attachments` | Upload run artifacts. |

Every `/api/runs/:id/*` call authenticates with that run's **exec token** (below),
not the runner token. `claim` (and a `peek`) updates the runner's `last_polled_at`
— that single signal drives the health surface.

## Claiming

`POST /api/runner/claim` returns the next claimable run as a full payload, or
`{ "run": null }`. A run is **claimable** by a runner when all hold:

1. **due** — a `scheduled` run with `scheduled_for <= now`, a `pending` agent run
   awaiting resume, **or** a recurring job past its `next_run_at` (materialized in
   the same transaction);
2. its **placement** matches one of the runner's advertised labels (and, for a
   remote token, a label it's authorized for — plus, if the token carries an
   `agentId` scope, the run must belong to that agent);
3. its **kind** is in `capabilities.kinds` and — for agent runs — the agent's CLI
   is in `capabilities.clis`;
4. its **lock unit** has nothing in flight: `agent_id` for agent runs, `job_id`
   for workflow runs. `running` and `pending` count as in flight; `waiting` does
   **not** — a run paused for human review leaves the agent idle, so its other
   work can still be claimed (#50).

The claim is one atomic transaction (oldest-due first, guarded status flip), so
concurrent claims **serialize for free** on the single SQLite writer — no runner
ever touches the database directly. Distinct lock units run in parallel, unbounded
by project, capped only by the runner's pool size.

## The exec token

The claim response includes a per-run **exec token** (`hbx_…`). It is the
credential for that run's lifecycle endpoints — the runner uses it for every
`/api/runs/:id/*` call, and hands it to the CLI it spawns (in the payload's `api`
block) so the high-value runner token never reaches the CLI. It is scoped to
exactly one run and is rotated on every (re)claim, so a prior attempt's token
stops working the moment the run is re-claimed.

## Run payload

Protocol-defined, kind-tagged. The runner reads `kind` to decide how to execute;
everything else is uniform.

```json
{
  "run":   { "id": "…", "status": "running", "title": null, "activity": [ … ] },
  "exec_token": "hbx_…",
  "job":   {
    "id": "…", "kind": "agent" | "workflow", "name": "…",
    "instructions": "… | null",
    "prerun":   { "runtime": "bash|python|node", "content": "…" } | null,
    "postrun":  { "runtime": "…", "content": "…" } | null,
    "postrun_gates": false,
    "command":  { "runtime": "…", "content": "…" } | null,   // workflow runs
    "workflow": { "runtime": "…", "content": "…" } | null,   // alias of command
    "model": null, "thinking": null, "title_format": null,
    "timeout_minutes": 30,
    "scripts_dir": "<project>/<agent>/<job-leaf>"   // workflows: "<project>/<job-leaf>"; under $HARBOUR_HOME/workflows
  },
  "agent":   {
    "cli": "opencode", "model": "openai/gpt-5.6", "thinking": "high", "eager": false,
    "provider": { "id": "…", "kind": "openai", "provider_id": "openai", "base_url": null, "protocol": "native", "credential_id": "…" }
  },                                                                                   // agent runs; provider only for OpenCode
  "runtime": { "llm": { "api_key": "sk-…" } },                                    // keyed OpenCode runs only; runner-private
  "workspace": { "project": "site", "agent": "dev" },                               // agent runs
  "docs":    [ … ],
  "tables":  { "<name>": { "id": "…" } },
  "env":     { "<NAME>": "<decrypted value>" },
  "attachments": [ … ],
  "api":     { "base_url": "…", "endpoints": { … }, "status_options": [ … ], "notes": [ … ] }
}
```

The runner branches on `job.kind`: drive a CLI session for `agent` (using `agent.cli`,
the `instructions`, and the `api` block), or run the gate script for `workflow`.
For gates, materialize the gate `content` into `scripts_dir` and run it with the
runtime's interpreter (`bash`/`python3`/`node`).

### OpenCode provider data

An OpenCode agent claim has two extra pieces with intentionally different audiences:

- `agent.provider` is non-secret connection metadata: `{ id, kind, provider_id, base_url, protocol, credential_id }`. `credential_id` is an opaque Secret identity (null for keyless connections), never its value. `kind` is `openai`, `anthropic`, `openrouter`, `ollama`, or `openai-compatible`. The agent/job model is always canonical `provider_id/model`, and `thinking` is the optional OpenCode variant.
- `runtime.llm.api_key` is the decrypted connection Secret. It is present only when the connection has a key; keyless Ollama/custom connections omit `runtime`. This block is **runner control data**, not model context. A Secret referenced by any LLM connection is reserved for provider auth and omitted from normal `env` even if pinned or job-linked.

A runner implementing OpenCode must extract and then remove the entire top-level `runtime` block before constructing a prompt or sending the claim JSON to any prerun/postrun gate. It must not log, persist, or return the key as agent output. Harbour's bundled runner generates typed inline OpenCode provider config, injects the key through a Harbour-owned child variable, prevents job variables from overriding its OpenCode controls, sets `OPENCODE_AUTH_CONTENT={}` and `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and redacts/caps captured provider output before posting it. The complete command/config control surface requires OpenCode 1.17.12 or newer.

`runtime` being runner-private means it is excluded from prompts and gates; it does **not** mean the credential is hidden from the spawned agent. OpenCode receives the key in its process environment, and a headless tool-capable agent can inspect or exfiltrate it. Exact-value output redaction cannot catch transformations or indirect use, so it is defense-in-depth, not containment. Values shorter than four characters are redacted only as standalone tokens because global substring replacement would corrupt ordinary output (for example, a one-character value would erase digits inside token counts and versions). Use a dedicated provider credential with budget and rate limits.

The bundled invocation is direct JSONL mode: `opencode run --pure --auto --format json --model <provider/model> --dir <workspace>`, plus `--session` and `--variant` when present. A non-secret fingerprint of the connection identity, credential identity, kind, provider ID, normalized endpoint, protocol, model, and variant is saved with the session. If it no longer matches at resume time, the runner discards the old session, posts an explanatory activity, and starts fresh. Replacing the value of the same Secret preserves context; switching the connection to a different Secret/account changes `credential_id` and starts fresh.

The bundled runner starts outside the repository and disables `opencode.json` / `.opencode/` project config, but keeps the runner user's normal XDG locations for sessions. Runner-host/global OpenCode config and plugins, the runner user's filesystem, and the spawned agent are part of the credential trust boundary. Because a remote runner receives the plaintext key at claim time, runner transport must be trusted TLS or a private network too.

`workspace` (agent runs only) holds the project/agent slugs; the bundled runner
derives the CLI's working directory from them as `workspaces/<project>/<agent>/`
under its Harbour home. Both `workspace` and `scripts_dir` are identity segments
resolved server-side — never absolute paths, and stable across renames. Runners
never delete these directories: deleting a project server-side leaves its
workspace and script dirs on the runner's disk, so a later project recreated
with the same slug reuses whatever files are left there.

## Lifecycle

```
scheduled → running → done | failed | skipped | killed
agent runs additionally:  running → waiting → pending → running → …
workflow runs never enter waiting/pending.
```

Terminal states are reported via `PUT /status`. `waiting`/`pending` are valid only
for agent runs; the server rejects them on workflow runs. `pending` is a human
action (a comment or retry) — an exec token asking for it gets a 403. The
exit-code convention for gates: `0` continues / succeeds, `77` skips, anything
else fails.

## The kill flow

The dashboard's Kill button sets an advisory flag. The runner notices two ways:
**piggyback** — every `POST /api/runs/:id/output` response includes
`kill_requested`; and a **fallback poll** of `GET /api/runs/:id/kill` when the CLI
is silent. On a set flag the runner sends `SIGTERM`, waits a grace period, then
`SIGKILL`, and saves the CLI session id via `PUT /session` so a comment can resume
the run.
