@README.md

Harbour is a control plane for AI agents doing ongoing work.

## Where to find what

One fact, one home — facts about how Harbour works live in [docs/](docs/README.md),
not here. Don't restate them in this file; route by task and read the doc first:

- **Deciding if a change fits** → [docs/prd.md](docs/prd.md) (north star) and [docs/README.md](docs/README.md) (map of every doc)
- **Changing code** → [docs/reference/architecture.md](docs/reference/architecture.md) first — auth model and route wrappers, polling ladder, run lifecycle, runner internals, and a ranked list of key source files
- **Touching API routes** → [docs/reference/api.md](docs/reference/api.md) — route map, the auth wrapper each route uses, `?orgId=`/`?projectId=` scoping rules
- **Touching the DB** → [docs/reference/database-schema.md](docs/reference/database-schema.md); the schema *is* `src/lib/db/schema.ts`
- **Building or restyling UI** → [docs/reference/design-language.md](docs/reference/design-language.md) — required reading, the color rules are strict
- **How a feature is meant to behave** → [docs/concepts/](docs/README.md#concepts--how-the-pieces-fit) — agents, jobs & runs, workflows, orgs & projects, shared context, Captain, attachments
- **On-the-wire payloads** → [docs/guide.md](docs/guide.md) / [docs/admin-guide.md](docs/admin-guide.md) — served live at `/api/guide` / `/api/admin-guide`, source of truth for wire behavior

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

1. Add a section at the top of `changelog.md` matching the existing style:
   `## vX.Y.Z — YYYY-MM-DD`, followed by one or more `### <Topic>` subheads
   with human-readable bullets (not raw commit subjects).
2. Bump both `package.json` and `package-lock.json` at once:
   `npm version X.Y.Z --no-git-tag-version`
3. Commit (this commit should ONLY touch the three files above):
   ```
   git add changelog.md package.json package-lock.json
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
