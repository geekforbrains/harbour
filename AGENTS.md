@README.md

Harbour is a control plane for AI agents doing ongoing work.

## Where to find what

One fact, one home — facts about how Harbour works, and how to run, develop, and
release it, live in [docs/](docs/README.md), not here. This file only routes you
there and flags the handful of tripwires below; it never restates doc content.
Route by task and read the doc first:

- **Running it locally / first run** → [docs/guides/getting-started.md](docs/guides/getting-started.md) — install, `harbour setup`, first boot
- **The local dev loop** → [docs/guides/local-development.md](docs/guides/local-development.md) — dev server + ports, validate/rebuild/restart, browser review, worktrees
- **Any development work** → [docs/reference/development-standards.md](docs/reference/development-standards.md) — **required reading before writing or testing any code**: validation commands, Biome rules, component/API/DB conventions, testing layout
- **Deciding if a change fits** → [docs/prd.md](docs/prd.md) (north star) and [docs/README.md](docs/README.md) (map of every doc)
- **Changing code** → [docs/reference/architecture.md](docs/reference/architecture.md) first — auth model and route wrappers, polling ladder, run lifecycle, runner internals, and a ranked list of key source files
- **Touching API routes** → [docs/reference/api.md](docs/reference/api.md) — route map, the auth wrapper each route uses, `?projectId=` scoping rules
- **Touching the DB** → [docs/reference/database-schema.md](docs/reference/database-schema.md); the schema *is* `src/lib/db/schema.ts`
- **Building or restyling UI** → [docs/reference/design-language.md](docs/reference/design-language.md) — required reading, the color rules are strict
- **How a feature is meant to behave** → [docs/concepts/](docs/README.md#concepts--how-the-pieces-fit) — agents, jobs & runs, workflows, projects, shared context, attachments
- **On-the-wire payloads** → [docs/guide.md](docs/guide.md) / [docs/management-guide.md](docs/management-guide.md) — served live at `/api/guide` / `/api/management-guide`, source of truth for wire behavior
- **Cutting a release** → [docs/guides/releasing.md](docs/guides/releasing.md) — changelog, version bump, tag

## Before you touch anything

A few tripwires worth knowing up front — everything else is in the docs above:

- **Port 3000 is production — never run a dev server on it.** Dev is 3001 (main repo) / 3010–3020 (worktrees). → [local development](docs/guides/local-development.md)
- **Rebuild + restart after every change.** A running server won't pick up a new build until restarted: `kill $(lsof -ti :3000); npm run build; npm start -- -p 3000 &`. (A `npm run dev` server hot-reloads and needs none of this.)
- **Node 24 LTS, enforced.** `npm install` fails on the wrong Node (`engine-strict`); after switching Node versions run `npm rebuild better-sqlite3` or Harbour won't boot (`NODE_MODULE_VERSION`).
- **Validate before calling work done:** `typecheck · lint · test · build` (+ `test:e2e` when UI or routes changed). Full ladder and conventions in [development standards](docs/reference/development-standards.md).
