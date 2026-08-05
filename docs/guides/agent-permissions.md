# Agent permissions

Every agent has a **Permissions** setting on its settings page: **Enforced** (the default) or **Unrestricted**. Enforced means the agent's CLI runs under a policy file in the agent's workspace, written in that CLI's own native format — `.claude/settings.json` for Claude Code, `.codex/config.toml` for Codex. Unrestricted is a deliberate per-agent opt-out that restores the CLI's permission-bypass flag.

Harbour validates the policy file but never writes or manages its content. You author it; the runner checks that it exists and is well-formed, refuses the specific shapes that provably cannot work headless (see [what Harbour checks](#what-harbour-checks)), and passes it to the CLI. An enforced agent with no valid policy file does not run: the run fails closed with a reason naming exactly what's missing, rather than silently running unrestricted.

Validation is structural, not semantic — it cannot tell whether your rules let the agent do its job. A well-formed policy that allows nothing the job needs passes every check and still gets no work done. The checks catch broken and self-contradictory files; getting the contents right is yours. The one thing you don't have to get right by hand is reporting: `harbour policy init` scaffolds that, and the section below explains it.

Permissions belong to the agent — there is no per-job override, so one job can't quietly widen what an agent may do.

The workspace is the agent's working directory at `~/.harbour/workspaces/<project-slug>/<agent-slug>/` (see [agents](../concepts/agents.md)). That's where the policy file lives, next to whatever else the agent works on.

## Just want to play

Set the agent's Permissions to **Unrestricted** in the dashboard (the agent's settings page; the agent then shows an Unrestricted badge). The runner launches the CLI with its bypass flag — `--dangerously-skip-permissions` for Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex — exactly the behavior every agent had before this setting existed. It's the cheapest way to get an agent working, the trade-off is yours to make per agent, and you can flip it back to Enforced whenever you're ready to author a policy file.

## Reporting back: `harbour update`

A restricted agent still has to tell Harbour what happened — set a run title, post progress, and reach a terminal status. That reporting is the `harbour update` command, which the agent runs in its own shell:

```bash
harbour update title "Reviewed this week's signups"
harbour update log "Fetched 42 rows, summarizing"
harbour update status done      # done | failed | waiting | skipped
```

It needs no URL and no key: the runner puts the run's identity and a per-run credential in the agent's environment (`HARBOUR_URL`, `HARBOUR_RUN_ID`, `HARBOUR_API_KEY`) when it spawns the CLI, and the command reads them from there. Outside a run it exits non-zero and says so.

The point is that **one narrow rule grants all of it**. The alternative — reporting over `curl` — can only be allowed with `Bash(curl *)`, which also hands the agent the entire internet and quietly defeats whatever else the policy restricts. `Bash(harbour update *)` grants reporting and nothing else: an agent holding only that rule cannot fetch a URL, read a file, or run any other command.

The rest of the API (attachments, docs, tables) is still curl, and still needs its own allow rule if a job uses it.

## Claude Code

The policy file is `<workspace>/.claude/settings.json` — Claude Code's own settings format (`permissions`, hooks, and the OS sandbox block all live here).

A minimal working policy:

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": ["Bash(harbour update *)"]
  }
}
```

That's what `harbour policy init` writes, and it's the floor every Claude policy builds on: it grants the agent nothing except the ability to report on its own run — set a title, post to the activity log, and reach a terminal status — through the [`harbour update`](#reporting-back-harbour-update) command.

> **Don't widen this to `Bash(harbour *)`.** That would also grant `harbour user create`, `harbour connect`, and the rest of the admin CLI. Keep the rule scoped to `harbour update`.

An agent with only that rule can't do any actual work — but it *can tell you so*, which is the difference between a run that fails legibly and one that fails mute. Add what the job needs on top.

How the runner launches it: `--settings <workspace>/.claude/settings.json --permission-mode <mode> --setting-sources project`, and no bypass flag. The file is passed explicitly with `--settings` rather than left to working-directory discovery because several sandbox keys (`strictAllowlist`, credential masking, `filesystem.disabled`) are ignored when they arrive from project-scope discovery and honored only from user/managed/`--settings` sources — discovery would silently drop exactly the keys that do the containing. `--setting-sources project` pins the remaining settings to the workspace, so the runner host's own `~/.claude/settings.json` can't loosen (or break) an agent.

`--setting-sources project` has a useful isolation side effect: **user-scope configuration doesn't load into enforced runs at all** — not `~/.claude/CLAUDE.md`, not user-level hooks or skills, not user-registered MCP servers (verified against Claude Code 2.1.222). Workspace-scope context still does, including `CLAUDE.md` files in the workspace and its ancestor directories, and skills in `<workspace>/.claude/skills/`. Loading and invoking a workspace skill is not itself permission-gated — the policy governs the tool calls the skill's instructions lead to, not the skill's availability — so a per-agent skill set in the workspace works under the scaffolded policy as-is. The full context-loading picture, for both CLIs and both modes, is in [context files and CLI state](../concepts/agents.md#context-files-and-cli-state).

How the rules behave:

- **`defaultMode` decides what happens to anything not allow-listed.** If the file doesn't set `permissions.defaultMode`, the runner applies `dontAsk`, which auto-denies unmatched tool calls — the right default headless, where a permission prompt has no UI to appear in. Accepted values are `dontAsk`, `acceptEdits`, `default`, `manual`, `plan`, and `auto`. `bypassPermissions` is refused: a workspace file may not grant itself a bypass — that's the dashboard's Unrestricted toggle, so the bypass stays visible where agents are managed.
- **Deny beats allow.** A command matching both lists is denied.
- **`Bash(...)` patterns match the literal command string**, not the command's effect: `Bash(curl *)` matches commands beginning with `curl `. Argument-level checks — blocking a particular flag, inspecting a URL — belong in a `PreToolUse` hook, which you can define in the same file (see Claude Code's own documentation for hooks).
- **`.claude/` is a protected path.** In enforced (non-bypass) modes the CLI refuses to edit files under `.claude/`, even with an allow rule that would otherwise cover them — the agent cannot rewrite its own policy file with its file tools. (This protection does not extend to code run through an allow-listed interpreter; see [Limits](#limits).)

A working policy is the scaffolded rule plus whatever the job genuinely needs, and denies for the commands you never want:

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": [
      "Bash(harbour update *)",
      "Bash(git *)",
      "Bash(npm *)"
    ],
    "deny": [
      "Bash(git push *)"
    ]
  }
}
```

The same file can also carry Claude Code's **OS sandbox** configuration — `sandbox.filesystem.*`, `sandbox.network.allowedDomains`, `sandbox.credentials`, `strictAllowlist`, `failIfUnavailable` — and it is honored, precisely because Harbour passes the file with `--settings` (the scope those keys require). Consult Claude Code's documentation for the key shapes; whatever you restrict, the run protocol still has to reach the Harbour API.

### Narrow allow rules with a workspace shim

Because patterns match the literal command string, a rule that has to accommodate a secret or a variable URL tends to get widened until it allows too much — `Bash(curl *)` is broad precisely because the interesting part of the command is unpredictable. (Reporting to Harbour used to have this problem; `harbour update` is the same trick, shipped.)

The workspace `bin/` directory is the way out. If the agent's workspace has one, the runner prepends it to `PATH` (see [agents](../concepts/agents.md#workspaces)), so a small wrapper script there resolves as a bare command name. Put the unpredictable part inside the script — where it reads env vars itself and execs the real tool — and the command the model emits becomes short, fixed, and narrowly matchable:

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": ["Bash(report-status *)"]
  }
}
```

This also keeps `$SECRET` references out of the command the model writes, which matters under `dontAsk`: an unmatched command is denied outright, so a shell expansion the model improvises is a failed tool call rather than a leaked value in the transcript.

## Codex

The policy file is `<workspace>/.codex/config.toml` — Codex's own config format. The boundary here is Codex's OS sandbox (`sandbox_mode`), which confines writes to the workspace; optional rules files (below) layer a command deny-list on top.

The minimal working policy — and the only working shape:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

> **`network_access = true` is not optional.** Under `workspace-write`, Codex's sandbox defaults to `network_access = false`, which blocks *every* connection — loopback included. Reporting to Harbour is an HTTP call either way, so an agent without network could do work and then be unable to report a title, activity, or status: every run would end `failed` at the finalize backstop with the real cause buried. Harbour refuses such a policy up front, naming the key, rather than letting that happen.

The other shapes are rejected for related reasons:

- **`danger-full-access` is refused.** It disables the sandbox entirely — a workspace file may not grant itself a bypass. If that's what you want, set the agent to Unrestricted in the dashboard, where the bypass is visible.
- **`read-only` is refused.** It blocks all network access (the same run-protocol problem), and the agent couldn't write its workspace either.
- An absent `sandbox_mode` defaults to `workspace-write` (Codex's own default), but the `network_access = true` line is still required — write both explicitly so the file says what it does.

How the runner launches it: `--skip-git-repo-check -s <sandbox_mode> -c approval_policy=never`, and no bypass flag. The sandbox mode is passed explicitly from the policy file so the effective mode is deterministic and visible in the process arguments; `--skip-git-repo-check` is required because agent workspaces usually aren't git repositories and Codex refuses to start in one otherwise; `approval_policy=never` because there is no UI to approve anything in.

### Optional command deny rules

`<workspace>/.codex/rules/*.rules` files add an execpolicy deny-list on top of the sandbox. Each rule names a command prefix and a decision:

```python
prefix_rule(
    pattern = ["git", "push"],
    decision = "forbidden",
)
```

- A rule matches when the command's argv begins with `pattern`. Decisions are `allow`, `prompt`, and `forbidden`; when several rules match one command, the most restrictive decision wins. Harbour runs Codex with approvals disabled, so use `forbidden` for anything you mean to block.
- **These are a deny-list, not an allow-list.** A command matching no rule simply runs, and there is no catch-all pattern — rules cannot express default-deny. The sandbox is the boundary; rules are a tripwire for specific commands.
- **A prefix deny-list is routed around trivially.** Forbid `touch` and the agent can still create a file with `python3 -c 'open("x","w")'`. Use rules to stop the obvious spelling of something, not to contain an adversary.

Validate a rules file with Codex itself:

```bash
codex execpolicy check --rules <file> -- <cmd> [args...]
```

A parseable file prints a JSON verdict to stdout and exits 0 regardless of the decision (`{"matchedRules":[],...}` means no rule matched — the command would run); a parse error prints to stderr and exits 1. Harbour runs this same check on every `.rules` file before each run: an absent `rules/` directory is fine, but a present-and-broken file fails the run, because Codex would otherwise skip it silently while you believe the deny-list is in force.

## What Harbour checks

Before each enforced run — after the workspace is resolved, before the CLI spawns — the runner resolves the agent's policy. Any failure means the CLI is never spawned. The checks:

For both CLIs, the policy file must:

- exist at the expected path (`<workspace>/.claude/settings.json` or `<workspace>/.codex/config.toml`),
- be a regular file — a symlink is refused rather than followed (a policy symlinked to `/dev/null` or an attacker-writable path must not be trusted),
- be non-empty.

For Claude Code, additionally:

- the file must parse as JSON,
- it must contain a `permissions` object (non-null, not an array),
- `permissions.defaultMode`, if present, must be one of the accepted modes above — `bypassPermissions` and unrecognized values are refused.

For Codex, additionally:

- top-level `sandbox_mode`, if present, must be `workspace-write` — `read-only`, `danger-full-access`, and unrecognized values are refused,
- the file must contain `network_access = true`,
- every `<workspace>/.codex/rules/*.rules` file, if the directory exists, must be a regular, non-symlink, non-empty file that Codex can parse.

When a check fails, the run gets an activity message with the precise reason — including the expected path and the remediation (write the policy file, or set the agent to Unrestricted in the dashboard) — and finishes `failed`. Nothing was executed.

## Workspace trust

Both CLIs honor a workspace's policy only when the host considers that workspace **trusted** — normally granted through an interactive dialog a headless runner never sees. Untrusted, the failure is quiet:

- **Claude Code silently drops `permissions.allow` entries** from an untrusted workspace ("Ignoring 1 permissions.allow entry … this workspace has not been trusted" on stderr) while still applying deny rules. The agent boots with allow-nothing: it looks alive and refuses nearly everything. Trust is recorded in `~/.claude.json` as `projects["<workspace>"].hasTrustDialogAccepted = true`.
- **Codex won't load a workspace's `.codex/` layer at all** (config.toml, rules/) unless the directory is trusted — recorded as a `[projects."<workspace>"]` table with `trust_level = "trusted"` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The runner passes the sandbox mode explicitly on the command line, so the sandbox holds regardless; trust is what makes the rest of the file — network access, rules — take effect.

The runner records trust automatically before each enforced run. It merges into the existing file — other keys are preserved, an entry already present is left alone, and a file it can't parse is left completely untouched. If trust could not be recorded, the run gets a **warning in its activity** instead of failing: it names the file and means the CLI may ignore parts of the policy (for Claude, the allow rules — expect the agent to refuse nearly everything) until you fix that file or accept the trust dialog interactively once.

One placement caveat: the Codex side honors `CODEX_HOME` when locating `config.toml`, but the Claude side always writes `~/.claude.json` — while Claude Code itself relocates that file into `$CLAUDE_CONFIG_DIR` when that variable is set. **Don't set `CLAUDE_CONFIG_DIR` in the runner's environment**: the bootstrap would record trust in a file the CLI never reads, and every enforced Claude run would boot allow-nothing with an untrusted-workspace warning.

After each work turn on an enforced Claude agent, the runner also scrapes Claude's "Ignoring N permissions…" warnings from stderr and posts them as run activity — those tell you a rule didn't apply, usually an untrusted workspace or a malformed pattern.

## Verifying and migrating

`harbour policy init <agent>` writes the starter policy for an agent, in that agent's CLI format, into its workspace:

```bash
npm run harbour -- policy init website/dev-agent
```

It writes the minimal working policy shown above — reporting and nothing else — and refuses to overwrite an existing file unless you pass `--force`. Run it on the host that runs the agent: the policy lives in the workspace, which is on the runner's machine, not the server's. Take a bare slug (`dev-agent`) when it's unique, or qualify it (`website/dev-agent`) when the same slug exists in more than one project.

`harbour policy check` validates every agent's policy without a server, in one command:

```bash
npm run harbour -- policy check
```

It reads the agents table straight from the SQLite database (read-only) and runs each agent through the **same** resolution the runner uses, against its workspace at `<HARBOUR_HOME>/workspaces/<project-slug>/<agent-slug>` — what this command approves is exactly what the runner will accept. Output is one line per agent — `project/slug`, CLI, mode, then `OK` or `FAIL` with the same reason a failing run would show — followed by a summary:

```
  website/dev-agent  claude  enforced      OK
  website/social     codex   unrestricted  OK
  ops/reports        claude  enforced      FAIL  Claude policy file (.claude/settings.json) not found at …

1 ok, 1 unrestricted, 1 failing
```

`--agent <slug>` narrows the check to agents with that slug — every project's, if the slug repeats; qualify it as `--agent <project>/<slug>` to pick just one. The exit code makes it a pre-deploy gate: 0 when every checked agent resolves (Unrestricted counts as resolved), 1 when at least one enforced agent would be refused (also 1 on unknown arguments, a slug that matches nothing, or a missing database).

**Upgrading makes every existing agent Enforced.** That is the point of the change: `enforced` is the default, and anything that isn't exactly `unrestricted` — including agents created before the setting existed — resolves to it, fail closed. After upgrading, run `harbour policy check`, then for each failing agent either author a policy file in its workspace or deliberately set it to Unrestricted in the dashboard. (Existing databases also need the one-time schema step in the [changelog](../../changelog.md) entry for this release.)

## Limits

Be clear-eyed about what this setting does and does not give you:

- **Redaction is not a boundary.** The runner redacts known secret values from output before it's logged or persisted, but the agent process has the plaintext in its environment — a policy file doesn't change that.
- **A broad Claude allow rule defeats the policy.** `Bash(python3 *)` hands the agent a general-purpose interpreter that can write any file the OS permits — including the policy file, since the `.claude/` protection covers the CLI's own file tools, not code run through an allow-listed interpreter. Keep allow rules narrow; patterns match literal command strings, nothing more.
- **Codex rules are bypassable by construction** — they're a prefix deny-list with no catch-all. The sandbox is the real write boundary; and because an enforced Codex agent must have `network_access = true` (the run protocol requires it), the sandbox confines writes, not network reach.
- **A Codex policy can widen its own sandbox.** Harbour validates `sandbox_mode` and `network_access`; it does not police the rest of the file. `writable_roots` under `[sandbox_workspace_write]` grants write access to paths you list, so `writable_roots = ["/"]` passes validation and gives the agent the whole filesystem. That's yours to choose deliberately, the same way a broad allow rule is on the Claude side — just don't read "the sandbox confines writes to the workspace" as true of a file that says otherwise.
- **The Codex sandbox doesn't cover global config or MCP servers.** `$CODEX_HOME/config.toml` is Codex's base configuration in enforced runs too — the workspace file layers on top of it — so anything registered there applies, including `mcp_servers`. And MCP servers are separate processes running *outside* the sandbox: their tools reach whatever the server process can reach, regardless of `sandbox_mode`. `$CODEX_HOME/AGENTS.md` likewise loads into enforced runs' context, as do user-level and bundled skills (`$CODEX_HOME/skills/`, `~/.agents/skills/`). (Enforced Claude agents are tighter here: `--setting-sources project` excludes user-scope MCP servers, memory, and skills — see [Claude Code](#claude-code) above.)
- **An agent holding a management API key can rewrite these settings.** A management key is a full user credential ([management guide](../management-guide.md)), so an agent whose job env carries one can flip any agent — including itself — to Unrestricted through the API, indistinguishable from an operator doing it. Per-run exec tokens can't: the agents routes reject them. Don't hand a management key to an agent you're deliberately constraining.
- **Unrestricted Claude agents can't run as root.** Claude Code refuses `--dangerously-skip-permissions` under root, so Unrestricted requires the runner to run as a non-root user — the layout [deploying to production](deploy-to-production.md) already uses.

## Next

- [Agents](../concepts/agents.md) — workspaces, placement, CLI configuration
- [docs/guide.md](../guide.md) — the run protocol the policy must leave reachable
- [Running a runner on a different machine](run-on-different-machine.md) — the policy file lives on whichever host runs the agent
