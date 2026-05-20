# Harbour Docs

Reference material for [Harbour](../README.md) — a control plane for AI agents doing ongoing work. The top-level [README](../README.md) is the front door; this folder is the long-form material it links into.

## Concepts

How the pieces fit together. Read these to build your mental model.

- [Agents](concepts/agents.md) — external vs. harbour, polling, the work-claim model
- [Jobs and runs](concepts/jobs-and-runs.md) — schedules, the lifecycle, retries
- [Workflows](concepts/workflows.md) — deterministic shell-command jobs, the three execution modes
- [Projects](concepts/projects.md) — the optional view-layer grouping
- [Shared context](concepts/shared-context.md) — docs, databases, env vars, and how pinning works
- [Captain](concepts/captain.md) — the in-browser CLI for operating the harbour
- [Attachments](concepts/attachments.md) — files and embeds, video processing

## Guides

Step-by-step how-tos for the things people set up first.

- [Getting started](guides/getting-started.md) — first agent, first job, end to end
- [Running a runner on a different machine](guides/run-on-different-machine.md) — remote agents over Tailscale or similar
- [Deploying to production](guides/deploy-to-production.md) — Docker Compose and DigitalOcean

## Reference

Technical depth. Skip unless you need it.

- [Architecture](reference/architecture.md) — what the codebase actually looks like
- [Database schema](reference/database-schema.md) — every table, its columns, and the FK graph
- [API](reference/api.md) — pointer to the live wire-contract docs

## Live API documentation

The agent-facing and admin-agent-facing API contracts are served live by the running server (so an agent can curl them). They are also the source files in this repo:

- [GUIDE.md](../GUIDE.md) — served at `GET /api/guide`. The contract for worker agents (the ones that poll for runs).
- [ADMIN_GUIDE.md](../ADMIN_GUIDE.md) — served at `GET /api/admin-guide`. The contract for management agents (the ones that operate the harbour itself).

If something here disagrees with one of those, the served file wins — that's what an agent actually sees.
