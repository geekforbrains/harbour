# Harbour documentation

Every Harbour doc has one job. This page is the map — start at the row that
matches what you're doing; you don't read it top to bottom.

| Doc | Owns | Reach for it when |
|---|---|---|
| [prd.md](prd.md) | The *why* and *what* — vision, principles, requirements, scope, roadmap | You're deciding what Harbour should do, or whether a change fits |
| [README](../README.md) | The front door — pitch, screenshots, quickstart, links | You're evaluating or installing Harbour |
| [concepts/](concepts/) | Mental models — how the pieces fit, in prose | You're building intuition for a feature |
| [guides/](guides/) | Step-by-step how-tos | You're setting something up |
| [reference/](reference/) | The *how* — architecture, schema, API surface, design language | You're changing the code |
| [guide.md](guide.md) · [management-guide.md](management-guide.md) · [runner-guide.md](runner-guide.md) | The on-the-wire contracts, served live at `/api/guide`, `/api/management-guide`, and `/api/runner-guide` (the Runner Protocol) | You're integrating an agent or a runner and need exact payloads |
| [changelog.md](../changelog.md) | Release history | You want to know what changed |

**One fact, one home.** Each fact lives in exactly one of these; everything else
links to it rather than restating it. When two docs disagree, the more specific
one wins — for on-the-wire behavior that's guide.md / management-guide.md (what an
agent actually sees); for code behavior, [reference/](reference/) and the source.

## Concepts — how the pieces fit

- [Agents](concepts/agents.md) — what an agent is, placement, and how runners claim its work
- [Jobs and runs](concepts/jobs-and-runs.md) — schedules, the lifecycle, retries
- [Workflows](concepts/workflows.md) — deterministic shell-command jobs and agent prerun gates
- [Projects](concepts/projects.md) — how projects organize work, and where everything lives
- [Shared context](concepts/shared-context.md) — docs, tables, secrets, and pinning
- [Attachments](concepts/attachments.md) — files and embeds

## Guides — set it up

- [Getting started](guides/getting-started.md) — first agent, first job, end to end
- [Local development](guides/local-development.md) — the day-to-day dev loop: dev server + ports, validate/rebuild/restart, browser review, worktrees
- [Running a runner on a different machine](guides/run-on-different-machine.md) — minting a credential and running a remote runner (`harbour-agent`, your own, or the bundled one; e.g. over Tailscale)
- [Deploying to production](guides/deploy-to-production.md) — Linux/systemd with a TLS proxy in front
- [Cutting a release](guides/releasing.md) — dev-to-main merge, changelog, version bump, tag, GitHub Release

## Reference — change the code

- [Development standards](reference/development-standards.md) — tooling, conventions, and testing rules; required reading before writing code
- [Architecture](reference/architecture.md) — what the codebase actually looks like
- [Database schema](reference/database-schema.md) — every table, its columns, and the FK graph
- [API](reference/api.md) — the route map; pointer to the live wire contracts
- [Design language](reference/design-language.md) — the dashboard's visual system
