# Harbour — Product Requirements

> **North star.** This document owns Harbour's *why* and *what*: the vision, the
> users, the principles it holds to, and the requirements it must meet. It does
> **not** describe *how* the system is built — that lives in
> [docs/reference](reference/) (architecture, schema, API) and the live wire
> contracts [guide.md](guide.md) / [admin-guide.md](admin-guide.md). When
> intent is unclear, resolve it here. When this document and the code disagree
> about *behavior*, the code wins and this document should be corrected.

## 1. What Harbour is

Harbour is a control plane for AI agents doing ongoing work. Teams hand agents
real, recurring responsibilities — marketing, support, dev, ops — and Harbour is
the layer underneath: it holds what recurring work each agent owns, gives them
shared context (docs, data, secrets), and surfaces the runs that need a human.

It is polling-based: Harbour never calls out to agents. Agents pull work on
their own schedule.

## 2. Why it exists

Agents can carry real workloads, but the moment they do, you lose visibility:
which agent owns what, what ran today, what's waiting on you, what broke. Harbour
exists to make ongoing agent work observable and operable without it becoming a
second full-time job.

## 3. Who it's for

- **Instance operator / admin** — owns the install; creates orgs, projects, and
  users; runs it on their own hardware.
- **Org members** — people scoped to an org, operating the agents, jobs, and runs
  within their projects.
- **Agents** — external integrations or Harbour-managed CLI tools that poll for
  and execute work.
- **Management / integrator agents** — admin-key holders that operate Harbour
  itself over the API.

## 4. Principles & constraints

The non-negotiables. A feature that violates one needs an explicit exception.

- **Poll, never push.** Harbour never initiates contact with an agent. Every
  unit of work is claimed by a poller.
- **Boring core.** One Next.js process + one SQLite file. No Redis, no queue, no
  background workers. `npm start` is the whole server. Run-claim is atomic via a
  SQLite transaction.
- **Local-first state.** Everything lives under `~/.harbour` (DB, uploads,
  encryption key, runner config). Back up one directory and you have everything.
- **Multi-tenant by construction.** Instance admin → **orgs** → **projects**.
  Resources never cross org lines.
- **Least privilege.** An agent can reach only its own run and the secrets and
  connection vars Harbour hands it — nothing more of the host or the database.
- **Public-app-grade security.** Harbour is multi-user; it must be safe to expose
  to more than one trusted operator behind normal access control. (See §6.)
- **Jobs are config; runs are work.** Jobs are static (what, when, which
  context). Runs are the dynamic unit that executes, succeeds, fails, or asks for
  a human.
- **Monochrome chrome, chromatic signal.** Neutral UI; color is reserved for run
  *status* and agent *identity*. (See [design language](reference/design-language.md).)

## 5. Functional requirements

What Harbour must let people and agents do. For endpoint- and schema-level
detail, see [docs/reference](reference/).

**Agents**
- Create a Harbour agent (Claude Code, Codex, or Gemini) run by a local or
  remote CLI runner.
- Set per-agent model, thinking/effort, and **identity color** — chosen from a
  curated palette, not auto-assigned.
- Run an agent on a different machine (remote runner) with model/CLI config
  resolved live from Harbour.

**Jobs & runs**
- Recurring jobs (schedule) plus one-off and triggered runs.
- A mechanically-enforced run lifecycle: `scheduled → running →
  {done | failed | skipped | killed}`, with a `waiting → pending` human-in-the-loop
  branch for agent runs.
- Retry failed/skipped/killed runs; kill a running run; resume a killed run from
  its saved session via a comment.

**Workflows**
- Deterministic, agentless, scheduled shell commands — no LLM involved. Claimed
  by the same runner that drives agent jobs.
- Agent **prerun** gates: a cheap command that decides whether to spend tokens on
  a run.

**Shared context**
- Docs (versioned markdown), tables (agent-managed SQLite tables), and secrets
  (encrypted env vars), linkable to jobs and composed into each run's payload.
- Dual-tier (org-level + project-level) plus job-linked; pinning pre-selects an
  item as a default on new jobs.

**Orgs & projects**
- The org → project hierarchy is the tenancy boundary; projects group and filter
  the work within an org.

**Operator surface**
- Captain: an in-browser CLI console for operating the harbour itself.
- Per-run attachments (files + embeds) with optional video transcription and
  storyboard generation.
- Dashboard for runs, jobs, agents, docs, tables, secrets, users, and settings.

**APIs**
- A worker wire contract ([guide.md](guide.md)) and an admin wire contract
  ([admin-guide.md](admin-guide.md)), served live so agents can read them.

## 6. Non-functional requirements

### Security posture (public-app-grade)

Harbour must be safe for a multi-user, internet-reachable deployment behind
normal access control. Requirements and current status (the C-/H-/M- codes are
stable labels for each item):

| Area | Requirement | Status |
|---|---|---|
| Authorization | Org → project roles; agents act only on their own resources; runners share one credential type | Done (v2) |
| Onboarding | Shell-based first-run admin (no web signup); argon2id password hashing; token set-password links | Done (v2) |
| Session cookie | `Secure` keyed to the connection protocol (works on localhost, secure behind TLS) | Done |
| Login | Rate-limiting + lockout/backoff + stronger password policy (no 2FA — out of scope) | Done (v2) — 5 failed attempts / 15 min per email+IP on login, 5/hour per IP on set-password, 12-char minimum |
| Secrets at rest | Env-var secrets are AES-256-GCM; sensitive settings (e.g. video API keys) encrypted the same way | Partial — settings encryption planned (M3) |
| Spawned-CLI env | Hand a spawned agent only an allowlist (PATH/HOME-type basics + Harbour connection vars) plus its job's secrets; strip everything else | Planned (H4) |
| DB column types | Runtime-allowlist `TEXT/INTEGER/REAL` — no SQL injection via a column type | Planned (C3) |
| Settings writes | Allowlist writable keys (already instance-admin-only) | Planned (H1) |
| Row APIs | Clamp read limits, bound rows per insert, reject oversized bodies | Planned (M5) |
| Uploads | Per-file cap, and reject when free disk is under 10% | Planned (H6) |
| File paths | Verify served/deleted attachment paths stay under the uploads directory | Planned (M4) |
| Attachment serving | Force-download untrusted types (SVG/HTML) + `X-Content-Type-Options: nosniff` | Done (v2) — strict inline allowlist; everything else served as `application/octet-stream` attachment |
| State files | `~/.harbour` is `0700`; state files are `0600` | Planned (H7) |

### Reliability & operability
- Single-binary deployment; one directory (`~/.harbour`) is the entire backup.
- Run-claim is atomic; two runners polling one org cannot double-claim a run.

### Portability
- macOS / launchd and Linux / systemd. No shipped container or IaC setup — containerizing is left to the operator.

## 7. Out of scope (by decision)

- **No 2FA** — no supported mechanism; not planned.
- **No intra-agent concurrency** — an agent executes one run at a time (`running`/`pending` serialize per agent). A run paused in `waiting` for human review is idle and doesn't hold the agent's lock, so the agent's other work isn't stranded behind an open-ended pause (#50).
- **No external datastore** — a single SQLite file; no Redis, queue, or worker pool.
- **No web signup** — the first admin is created from the shell; further users
  are invited.
- **No v1 → v2 migration** — v2 is a clean break; a fresh database is the only
  supported path.

## 8. Roadmap

Open requirements, prioritized. The security items are the §6 requirements.

**Security hardening (next):** C3 DB column-type allowlist · H4 spawned-CLI env
allowlist · H7 file permissions · H6 upload disk guard · M3 encrypt
sensitive settings · M4 path containment · M5 row limits · H1 settings write
allowlist. (H2 attachment force-download + nosniff and M1 login rate-limit /
password policy shipped in v2 — see §6.)

## 9. How the docs fit

This PRD is the top of the pyramid. For the **map of every doc and its role**,
see [docs/README.md](README.md). In short: this PRD owns *why / what*;
[docs/reference](reference/) owns *how*; [guide.md](guide.md) and
[admin-guide.md](admin-guide.md) are the on-the-wire source of truth.
