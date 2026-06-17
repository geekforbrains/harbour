# Development standards

How code gets written, validated, and tested in this repo. **Required reading
before any development work.** These conventions were chosen deliberately
(June 2026, against then-current Next.js/React/Biome/Vitest guidance) — follow
them as written; don't "modernize" them to match outside defaults without a
decision recorded here.

## Validation commands

Every change must pass, in this order:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check (lint + format + import order)
npm run test        # vitest unit suite
npm run build       # next build — before calling work done
npm run test:e2e    # playwright smoke suite — when UI or routes changed
```

Helpers: `npm run lint:fix` (auto-fix lint + formatting), `npm run format`
(format only). CI (`.github/workflows/ci.yml`) runs typecheck, lint, and test
in parallel, with build gated on all three; e2e runs locally only.

## Tooling: Biome, all-in

[Biome](https://biomejs.dev) (`biome.json`) is the single tool for linting,
formatting, and import organizing. There is no ESLint and no Prettier — don't
reintroduce them. Formatting is non-negotiable: double quotes, 2-space indent,
semicolons, 100-char lines. Never hand-format; run `npm run lint:fix`.

**Strict by default, loosen only as a last resort.** The linter runs Biome's
recommended rules plus the `react`, `next`, and `test` domains. When a rule
fires:

1. Fix the code properly.
2. If the pattern is genuinely intentional, suppress that one line with
   `// biome-ignore lint/<group>/<rule>: <real reason>` — the reason is
   mandatory and must say *why* the pattern is correct here.
3. Only if a whole directory legitimately can't satisfy a rule, add a scoped
   override in `biome.json`.

Current sanctioned exceptions (don't add more without recording them here):

- `noExplicitAny` is off in `src/lib/db/**` only — SQLite rows are untyped at
  the driver boundary. Everywhere else, type it properly or use `unknown` and
  narrow.
- `noNonNullAssertion` is off globally — auth wrappers guarantee
  `?orgId=`/`?projectId=` presence, so `param!` after a wrapper is the
  codebase idiom.
- `src/app/globals.css` is excluded — Biome's CSS parser doesn't understand
  Tailwind v4 directives.

## TypeScript

`strict: true` stays on. No `any` outside `src/lib/db/` (see above). Prefer
real types, then `unknown` + narrowing, then a small local type — in that
order. Unused parameters are prefixed `_`.

## React and components

- **Function declarations** for components (`export function RunRow(...)`),
  never `React.FC`, never arrow-function components.
- **kebab-case filenames, PascalCase exports**: `run-row.tsx` exports
  `RunRow`. shadcn/ui primitives live in `src/components/ui/`, app components
  in `src/components/app/`, providers in `src/components/providers/`.
- **Props**: explicit named `type Props = {...}` (or inline for one or two
  props); `children` is `React.ReactNode`.
- `"use client"` goes on the smallest component that needs interactivity, not
  on wrappers. Layouts stay server components.
- Don't reach for `useEffect` for derived data, event responses, or state
  resets — see [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).
- Manual `useMemo`/`useCallback` only with a measured reason. The **React
  Compiler is deliberately not adopted**; when revisited, the path is
  `compilationMode: 'annotation'` (opt-in per component).
- UI styling rules live in [design-language.md](design-language.md) — required
  reading for any UI work.

## API routes

The full route conventions are in [api.md](api.md) and
[architecture.md](architecture.md). The law, briefly:

- Exactly **one auth wrapper** from `src/lib/auth.ts` per exported handler —
  never a bare handler, never two wrappers.
- **Manual validation** of inputs at the top of the handler (no Zod or schema
  libraries): check required fields, return
  `NextResponse.json({ error: "..." }, { status: 400 })`.
- All responses via `NextResponse.json`; errors are always
  `{ error: string }` with a correct status code (400/403/409/429). A cross-org
  lookup of a route's **primary** (path-param) resource returns 403, not 404; but a
  **body-supplied** resource id from another org (e.g. a doc/env-var/table link
  target) returns 404 — uniform with a missing id, so it leaks no cross-tenant
  existence.

## Database

Raw `better-sqlite3` — **protected convention**: no ORM, no query builder, no
migration framework. Don't propose Drizzle/Prisma; the single-file,
local-first design is the point.

- Schema lives in `src/lib/db/schema.ts` as idempotent DDL
  (`CREATE TABLE IF NOT EXISTS`); schema changes are edits there, mirrored in
  [database-schema.md](database-schema.md).
- Queries are prepared statements in per-entity modules
  (`src/lib/db/<entity>.ts`), re-exported through `src/lib/db/queries.ts`.
  Routes import from `queries`, never open their own connection.
- Pragmas (`WAL`, `busy_timeout`, `foreign_keys`) are set in one place at
  connection open.
- `db.transaction()` callbacks must be **synchronous** — an `await` inside one
  commits early and silently. Keep transactions small and tight.

## Testing

**Unit tests (Vitest)** — `src/__tests__/<topic>.test.ts`, never colocated
with source. Default environment is `node`; a test that renders DOM adds
`// @vitest-environment jsdom` as its first line and uses
`@testing-library/react`. DB tests build a fresh in-memory SQLite via the
existing `setDb()`/`initializeSchema()` pattern — copy an existing test's
setup rather than inventing one. Route tests call the exported handler
directly with a mocked `NextRequest`.

**E2E tests (Playwright)** — `e2e/<topic>.spec.ts`, run with
`npm run test:e2e`. The suite self-hosts: it seeds a throwaway Harbour home in
`.e2e/` and boots a dev server on port 3030 (`e2e/setup-and-start.mjs`), with
auth handled once in `e2e/auth.setup.ts`. **Every feature that adds UI or
routes extends this suite with its happy path** — the suite is small today and
grows with the product. Async server components can only be tested here, not
in Vitest.

`playwright-cli` remains the tool for *manual* visual review and screenshots
during development (see AGENTS.md); it is not the integration story.

## Naming

- Files and routes: kebab-case (`env-vars`, `run-row.tsx`, `agent-color.ts`).
- Hooks: `use-` prefix in `src/lib/hooks/`.
- Tests: `*.test.ts(x)` for unit, `*.spec.ts` for e2e.
- One source of truth per concept (status colors in `src/lib/status.ts`,
  query keys in `src/lib/api/keys.ts`) — extend the existing home, don't fork
  a second copy.
