# Local development

The day-to-day loop for working on Harbour itself: running a dev server, the
validate-and-restart cycle, visual review, and parallel work with worktrees.
First-time setup (install, `harbour setup`, first boot) is in
[getting started](getting-started.md); the validation commands and code
conventions are in [development standards](../reference/development-standards.md).

## Dev server and ports

Have a dev server running before you test UI changes or drive the browser. Port
conventions in this repo:

- **4272** — production server (reserved; never run a dev server here)
- **3001** — main-repo dev server (`npm run dev`)
- **3010–3020** — worktree dev servers, one per worktree

Check what's already bound before starting, then take the lowest free port:

```bash
lsof -iTCP:3010-3020 -sTCP:LISTEN   # which worktree ports are taken
npm run dev -- -p 3010
```

`npm run dev` launches `next dev` with the safe project defaults (fast refresh,
no build step). It still needs a
first-run user to log in — see [getting started](getting-started.md).

## The change loop

After making changes, run the full validation ladder before calling work done —
the commands and order live in
[development standards](../reference/development-standards.md#validation-commands)
(`typecheck · lint · test · build`, plus `test:e2e` when UI or routes change).

If you're iterating against the **production** server on :4272, it won't pick up
a new build until you restart it:

```bash
kill $(lsof -ti :4272)  # stop the running production server
npm run build           # rebuild
npm start &             # restart in the background
```

A `npm run dev` server hot-reloads, so the rebuild dance is only for the
production build on :4272.

## Browser review and screenshots

`playwright-cli` drives a real browser for **manual** visual review and
screenshots during development. The dev server must already be running.

```bash
playwright-cli open "http://localhost:3010/some-page"   # browser persists across commands

# Auth: set the session cookie (grab a valid id from the sessions table)
playwright-cli eval "document.cookie = 'harbour_session=SESSION_ID; path=/'"
playwright-cli goto "http://localhost:3010/some-page"   # reload with auth

playwright-cli screenshot --full-page --filename /tmp/shot.png
playwright-cli resize 1280 900     # desktop
playwright-cli resize 390 844      # mobile (iPhone 14)
playwright-cli snapshot            # accessibility tree (element refs)
playwright-cli click <ref>         # interact with an element
playwright-cli eval "<js>"         # run JS in the page
```

This is for manual review only — the automated integration story is the
Playwright e2e suite (`npm run test:e2e`), covered in
[development standards](../reference/development-standards.md).

## Parallel development with worktrees

Run multiple Claude Code sessions at once, each on its own branch and file tree:

```bash
claude --worktree feature-auth      # Terminal 1 — branch worktree-feature-auth
claude --worktree bugfix-notifs     # Terminal 2
claude                              # Terminal 3 — main repo on the current branch
```

- Each worktree needs its own `npm install`.
- `.worktreeinclude` copies `.env` / `.env.local` into new worktrees automatically.
- All worktrees share `~/.harbour/harbour.db` by default. For an isolated
  database, set `HARBOUR_DB_PATH` in a per-worktree `.env`.
- Use a distinct port per worktree dev server (3010–3020).
- Merge back via PR: `git push origin worktree-<name>` then `gh pr create`.
- Cleanup: worktrees with no changes are auto-removed on session exit; otherwise
  `git worktree remove .claude/worktrees/<name>`.
