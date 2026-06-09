# Harbour documentation

Every Harbour doc has one job. This page is the map — start at the row that
matches what you're doing; you don't read it top to bottom.

| Doc | Owns | Reach for it when |
|---|---|---|
| [PRD.md](PRD.md) | The *why* and *what* — vision, principles, requirements, scope, roadmap | You're deciding what Harbour should do, or whether a change fits |
| [README](../README.md) | The front door — pitch, screenshots, quickstart, links | You're evaluating or installing Harbour |
| [concepts/](concepts/) | Mental models — how the pieces fit, in prose | You're building intuition for a feature |
| [guides/](guides/) | Step-by-step how-tos | You're setting something up |
| [reference/](reference/) | The *how* — architecture, schema, API surface, design language | You're changing the code |
| [GUIDE.md](../GUIDE.md) · [ADMIN_GUIDE.md](../ADMIN_GUIDE.md) | The on-the-wire contracts, served live at `/api/guide` and `/api/admin-guide` | You're integrating an agent and need exact payloads |
| [CHANGELOG.md](../CHANGELOG.md) | Release history | You want to know what changed |

**One fact, one home.** Each fact lives in exactly one of these; everything else
links to it rather than restating it. When two docs disagree, the more specific
one wins — for on-the-wire behavior that's GUIDE.md / ADMIN_GUIDE.md (what an
agent actually sees); for code behavior, [reference/](reference/) and the source.

## Concepts — how the pieces fit

- [Agents](concepts/agents.md) — external vs. harbour, polling, the work-claim model
- [Jobs and runs](concepts/jobs-and-runs.md) — schedules, the lifecycle, retries
- [Workflows](workflows.md) — deterministic shell-command jobs and agent prerun gates
- [Projects](concepts/projects.md) — orgs, projects, and view-layer grouping
- [Shared context](concepts/shared-context.md) — docs, databases, secrets, and pinning
- [Captain](concepts/captain.md) — the in-browser CLI for operating the harbour
- [Attachments](concepts/attachments.md) — files and embeds, video processing

## Guides — set it up

- [Getting started](guides/getting-started.md) — first agent, first job, end to end
- [Running a runner on a different machine](guides/run-on-different-machine.md) — remote agents over Tailscale or similar
- [Deploying to production](guides/deploy-to-production.md) — Docker Compose and DigitalOcean

## Reference — change the code

- [Architecture](reference/architecture.md) — what the codebase actually looks like
- [Database schema](reference/database-schema.md) — every table, its columns, and the FK graph
- [API](reference/api.md) — the route map; pointer to the live wire contracts
- [Design language](reference/design-language.md) — the dashboard's visual system
