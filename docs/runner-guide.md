# Runner Protocol

The contract any runner implements to execute Harbour work. This page is the
**source of truth for on-the-wire behavior** and is served live at
`/api/runner-guide`. The runner Harbour ships (`harbour run`) is just the first
implementation; it has no privileged path a third-party runner couldn't take.

Harbour is the **control plane** (source of truth, queue, lifecycle, the dashboard).
A runner is the **execution plane**: it asks "what's next?", runs it, reports
progress, finalizes. A runner knows nothing about orgs — execution is org-agnostic.

## Identity

A runner authenticates with a bearer token (`hbrn_…`) on the `Authorization`
header. There are two tiers — the **same protocol**, different trust:

| | Local | Remote |
|---|---|---|
| Trust | trusted, **unscoped** — claims any `placement = local` work across every org | **scoped** — claims only work matching its authorized labels (+ optional org/agent scope) |
| Token | `~/.harbour/runner.token` (0600), auto-provisioned at setup | minted by an operator, held on the runner's own host |

The local token can read every org's decrypted secrets (run payloads carry them).
That's acceptable because **all executable content is operator-authored** — the
host is the trust boundary. Treat it like the DB and encryption key: local only,
never shipped off-box.

## Capabilities

On **every** claim the runner advertises what it can run, so the server only
hands it work it can execute:

```json
{
  "kinds":  ["agent", "workflow"],   // run kinds this runner executes
  "clis":   ["claude", "codex"],     // for agent runs: which CLIs are installed
  "labels": ["local"]                // placement labels this runner serves
}
```

The bundled runner detects these from the host (installed CLIs + shell) and
advertises `labels: ["local"]`. A remote runner advertises whatever
`HARBOUR_RUNNER_LABELS` gives it (comma-separated, default `["local"]`); its token
scope is the ceiling the server enforces on what it may claim, not what it advertises. **Capability honesty:** the server never assumes a CLI is present —
an agent run is handed out only if the agent's CLI is in `clis`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runner/claim` | Claim the next runnable unit. Body: `{ "capabilities": {…} }`. `?peek=true` checks liveness/availability without claiming. |
| `POST` | `/api/runs/:id/output` | Append captured CLI output (agent runs). Response piggybacks `{ kill_requested }`. |
| `POST` | `/api/runs/:id/activity` | Append a progress breadcrumb / captured output. |
| `PUT`  | `/api/runs/:id/status` | Drive the lifecycle: `done`/`failed`/`skipped`/`killed`, plus `waiting`/`pending` for agent runs. |
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
   remote token, a label it's authorized for);
3. its **kind** is in `capabilities.kinds` and — for agent runs — the agent's CLI
   is in `capabilities.clis`;
4. its **lock unit** has nothing in flight: `agent_id` for agent runs, `job_id`
   for workflow runs; `running | waiting | pending` all count as in flight.

The claim is one atomic transaction (oldest-due first, guarded status flip), so
concurrent claims **serialize for free** on the single SQLite writer — no runner
ever touches the database directly. Distinct lock units run in parallel, unbounded
by org, capped only by the runner's pool size.

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
    "scripts_dir": "<org>/<project>/<agent>/<job-leaf>"      // under $HARBOUR_HOME/workflows
  },
  "agent":   { "cli": "claude", "model": null, "thinking": null, "eager": false },  // agent runs
  "workspace": { "org": "acme", "project": "site", "agent": "dev" },                // agent runs
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

## Lifecycle

```
scheduled → running → done | failed | skipped | killed
agent runs additionally:  running → waiting → pending → running → …
workflow runs never enter waiting/pending.
```

Terminal states are reported via `PUT /status`. `waiting`/`pending` are valid only
for agent runs; the server rejects them on workflow runs. The exit-code convention
for gates: `0` continues / succeeds, `77` skips, anything else fails.

## The kill flow

The dashboard's Kill button sets an advisory flag. The runner notices two ways:
**piggyback** — every `POST /api/runs/:id/output` response includes
`kill_requested`; and a **fallback poll** of `GET /api/runs/:id/kill` when the CLI
is silent. On a set flag the runner sends `SIGTERM`, waits a grace period, then
`SIGKILL`, and saves the CLI session id via `PUT /session` so a comment can resume
the run.
