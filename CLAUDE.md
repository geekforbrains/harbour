@README.md

Harbour is the BORG Interface control plane for AI agents doing ongoing work. See README.md for full architecture, API surface, and design rationale.

## Tech

Next.js (App Router), SQLite (better-sqlite3), Tailwind / shadcn/ui, TypeScript.

## Key paths

- `src/app/(app)/` — dashboard pages (runs, jobs, agents, docs, databases, env-vars, settings)
- `src/app/api/` — API routes (agent-facing + dashboard), all use `withAuth`/`withUserAuth` wrappers
- `src/lib/db/projects.ts` — project CRUD + linking/unlinking (auto-links job dependencies)
- `src/lib/db/workspaces.ts` — workspace CRUD for businesses/operating areas above projects
- `src/components/app/project-switcher.tsx` — sidebar/mobile workspace + project selector with create dialogs
- `src/components/app/project-link-dialog.tsx` — "Add Existing" dialog for linking items to projects
- `src/lib/hooks/use-project-filter.ts` — hook for passing active project to API queries
- `src/lib/auth.ts` — `withAuth`, `withUserAuth`, `requireAgentOwnership` HOF wrappers for API routes (admin API keys resolve to creating user's identity)
- `src/lib/db/admin-api-keys.ts` — admin API key CRUD + authentication
- `ADMIN_GUIDE.md` — admin agent onboarding guide, served at `/api/admin-guide`
- `src/lib/db/` — database schema, queries, migrations
- `src/lib/encryption.ts` — AES-256-GCM encryption for env vars
- `src/lib/schedule.ts` — schedule parsing and timezone-aware next-run-time calculation
- `src/lib/cli-config.ts` — shared CLI tool config (models, thinking options per tool)
- `src/lib/runners.ts` — harbour agent runner config (read/write ~/.harbour/runners.json)
- `src/components/app/create-dialog.tsx` — unified New Run / New Job dialog (shared component, dynamic type toggle for agent/workflow)
- `src/components/app/trigger-dialog.tsx` — shared trigger confirmation modal with optional extra instructions
- `src/components/app/model-thinking-select.tsx` — shared Model/Thinking select for CLI agents
- `bin/` — CLI entry point and agent runner (harbour agents, workflow execution, providers, launchd install)
- `src/app/api/workflows/next/` — runner endpoint for discovering agentless workflow-only runs
- `GUIDE.md` — agent-facing API contract, served at `/api/guide`

## Conventions

- Jobs are static configuration (what to do, when, which docs/databases/env vars). Runs are the dynamic unit of work.
- Jobs are either agent jobs (belong to an agent), workflow-only jobs (no agent, shell command only), or combined (workflow gates the agent). Workflow-only jobs have nullable `agent_id`.
- Docs and env vars are top-level, linked to jobs. Injected into runs automatically via `/next`.
- Pinned docs and env vars are auto-attached to all new jobs and one-off runs.
- Agents poll for work via `/api/agents/:id/next`. Agentless workflow jobs are discovered via `/api/workflows/next`. Harbour never calls out to agents.
- Run statuses: `scheduled` → `running` → `waiting` (needs human) → `pending` (human responded, awaiting agent pickup) → `done`/`failed`/`skipped`.
- Failed/skipped runs can be retried (go back to `pending`).
- AgentOps-declared Harbour agents with `harbour.cli` metadata are synced idempotently by `scripts/sync-toolkit-libraries.mjs`; current global example is `x-com-agent-scraper` / **X.com agent scraper**.
- The database is a single SQLite file (default `./harbour.db`).
- Env vars are encrypted with AES-256-GCM. Key at `~/.harbour/encryption.key` (auto-generated on first run).
- System timezone (configured in Settings) is used for all schedule calculations.
- Model and thinking/effort can be set per agent (default) and overridden per job.
- API routes use `withAuth(handler)` or `withUserAuth(handler)` — never inline auth checks. Agent-facing mutation routes use `requireAgentOwnership()` to enforce scope.
- Job and run creation functions (`createJob`, `createOneOffRun`, `getAgentNextRun`) are wrapped in transactions.
- Workspaces are top-level business/operating areas. Projects belong to workspaces. Entities don't know about projects directly — linking tables hold the references. All list queries accept an optional `projectId` filter. Adding a job to a project auto-links its agent, docs, env vars, and databases.

## Dev server

Always start a dev server before testing UI changes locally or using the playwright-browser skill. Check which ports are in use first, then pick an available one:

- **Port 3000** — production server (reserved, never use for dev)
- **Port 3001** — main repo dev server (`npm run dev -- -p 3001`)
- **Ports 3010-3020** — worktree dev servers (one per worktree)

Before starting a dev server, run `lsof -iTCP:3010-3020 -sTCP:LISTEN` to see which ports are already taken, then use the lowest available port in the range.

```bash
# Start dev server in a worktree (pick an available port from 3010-3020)
npm run dev -- -p 3010
```

## Development workflow

```bash
# 1. Make changes, then validate
npm run lint                    # ESLint (pre-existing `any` warnings are expected)
npm run test                    # Vitest unit tests
npm run build                   # Next.js production build

# 2. Rebuild and restart production (REQUIRED after every change — the
#    running server won't pick up a new build until restarted)
kill $(lsof -ti :3000)          # stop current production server
npm run build                   # rebuild
npm start -- -p 3000 &          # restart in background
```

## Release flow

Cutting a tagged release is manual — `npm run release` only rebuilds and
bounces the local stack (macOS/launchd), it does NOT create a version. The
release itself is a single commit touching three files, then a tag.

For a release `vX.Y.Z`:

1. Add a section at the top of `CHANGELOG.md` matching the existing style:
   `## vX.Y.Z — YYYY-MM-DD`, followed by one or more `### <Topic>` subheads
   with human-readable bullets (not raw commit subjects).
2. Bump both `package.json` and `package-lock.json` at once:
   `npm version X.Y.Z --no-git-tag-version`
3. Commit (this commit should ONLY touch the three files above):
   ```
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "chore: release vX.Y.Z"
   ```
4. Tag and push:
   ```
   git tag vX.Y.Z
   git push && git push origin vX.Y.Z
   ```

Version bump convention:
- **Patch** (e.g. v1.11.0 → v1.11.1) — bug fixes only
- **Minor** (e.g. v1.10.1 → v1.11.0) — new features, backwards-compatible
- **Major** — breaking changes (none cut so far)

## Browser testing / screenshots

Use `playwright-cli` for visual review and screenshots. The dev server must be running first (see above).

```bash
# Open browser and navigate (browser persists across commands)
playwright-cli open "http://localhost:3010/some-page"

# Auth: set session cookie (get a valid session ID from the sessions table)
playwright-cli eval "document.cookie = 'harbour_session=SESSION_ID; path=/'"
playwright-cli goto "http://localhost:3010/some-page"  # reload with auth

# Screenshots
playwright-cli screenshot --full-page --filename /tmp/screenshot.png

# Resize for mobile/desktop testing
playwright-cli resize 1280 900    # desktop
playwright-cli resize 390 844     # mobile (iPhone 14)

# Other useful commands
playwright-cli snapshot           # accessibility tree (element refs)
playwright-cli click <ref>        # interact with elements
playwright-cli eval "js expression"  # run JS in page context
```

## Parallel development (git worktrees)

Use `claude --worktree <name>` to run multiple Claude Code sessions in parallel. Each worktree gets its own branch (`worktree-<name>`) and isolated file tree.

```bash
claude --worktree feature-auth       # Terminal 1
claude --worktree bugfix-notifs      # Terminal 2
claude                               # Terminal 3 — main repo on current branch
```

- Each worktree needs its own `npm install`.
- `.worktreeinclude` copies `.env` / `.env.local` to new worktrees automatically.
- All worktrees share the same `~/.harbour/harbour.db` by default. For isolated databases, set `HARBOUR_DB_PATH` in a per-worktree `.env`.
- Use different ports if running dev servers in multiple worktrees (3010-3020 range).
- Merge back via PR: `git push origin worktree-<name>` then `gh pr create`.
- Cleanup: worktrees with no changes are auto-removed on session exit. Otherwise `git worktree remove .claude/worktrees/<name>`.
