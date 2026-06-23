# Design language

The visual system for Harbour's dashboard. Adopted in the v2 redesign. If you
are building or restyling any dashboard UI, follow this — it is what keeps the
interface legible at a glance.

## Concept: monochrome chrome, chromatic signal

The interface chrome is **neutral** — true black, white, and grey. Saturated
color is reserved for **information**, never decoration. A colored pixel on
screen always means something.

The palette is token-driven in [`src/app/globals.css`](../../src/app/globals.css):
neutrals are OKLCH with chroma `0`, `--primary` is near-black (inverted to
near-white in dark mode), borders are hairline, radius is `0.5rem`. Dark mode is
genuinely black. Because everything reads from these tokens, restyling is a
token change, not a per-component sweep — **do not hardcode hex or palette
colors for chrome** (backgrounds, text, borders, buttons). Use the semantic
tokens (`bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`, …).

## The governing rule

> **Shape tells you the type. Color tells you the state and who.**

And: **at most two color dimensions in any one view.** On the Runs list that is
status (always) + a small agent dot. Nothing else competes.

Color is allowed in exactly two systems:

### 1. Run status — the primary color system

Single source of truth: [`src/lib/status.ts`](../../src/lib/status.ts). The
components [`RunStatusIcon`, `StatusDot`, `StatusBadge`](../../src/components/app/run-status.tsx)
all read from it, so the mapping can never drift. Never re-declare a status
color inline.

| Status | Hue | Meaning |
|--------|-----|---------|
| `scheduled` | slate | queued for the future, inert |
| `running` | blue | working now |
| `waiting` | amber | needs a human |
| `pending` | violet | human replied, queued for pickup |
| `done` | emerald | success |
| `failed` | red | error |
| `killed` | orange | stopped mid-run |
| `skipped` | grey / muted | nothing to do |

Convention: `-500` for icon/dot, `-500/10` for the tint background, `-600`
(light) / `-400` (dark) for badge text. Class strings are written out in full so
Tailwind's JIT scanner sees them — never build status classes dynamically.

### 2. Agent identity — a subtle secondary signal

[`src/lib/agent-color.ts`](../../src/lib/agent-color.ts) gives each agent a
color from a 16-hue, perceptually-spread palette (`AGENT_COLORS`). The point is
telling agents apart from **each other** when many stack up in one list
(per-project agents). It is used only as:

- a small dot beside the agent's name (run rows, metadata lines), or
- a tinted avatar (Agents list).

Never a filled row or card. **Status overrides identity** when attention is
needed: a waiting/pending agent avatar shows the status color, not its identity
color.

The color is a stored, user-chosen column on the agent — picked via the shared
`AgentColorPicker` component in the create and settings dialogs. Agents without
a stored color fall back to a name hash (full 32-bit reduction — a power-of-two
modulo clusters short names) over the first 8 hues, which are biased away from
the loaded status hues. Display sites resolve via `resolveAgentColor(stored,
name)` — never read the hash directly when the stored column is available.

## What does NOT get color

- **Agent vs workflow** — distinguished by icon shape (`Bot` vs `Terminal`), not
  color.
- **Docs / Tables / Env Vars / Jobs** — each has a distinct lucide icon and a
  page header. They stay monochrome. Giving entity *types* their own colors is
  the "overboard" line; it dilutes the status and agent signals.

## Quick checklist for new UI

- Chrome uses semantic tokens, no hardcoded palette colors.
- Status color comes from `statusStyle()` / the `run-status` components.
- Agent color comes from `agentColor()`, used as a dot/avatar accent only.
- Entity type is conveyed by icon shape, not color.
- Count the colors in your view: if it's more than status + agent, cut one.
