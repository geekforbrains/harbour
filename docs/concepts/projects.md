# Projects

Projects are an optional view-layer grouping. They don't own anything. The whole feature is a sidebar dropdown plus a handful of junction tables — switching projects filters the dashboard, and that's the entire visible surface.

## The mental model

A project is a bag of references — a set of agents, jobs, docs, env vars, and databases. The references live in junction tables (`project_agents`, `project_jobs`, `project_docs`, `project_env_vars`, `project_databases`). The underlying entities know nothing about projects: they're top-level rows with their own ids, and the same row can be referenced by zero, one, or many projects.

This shape was chosen because real fleets share things across projects. One `Developer` agent might serve two products; a "Brand voice" doc gets pinned to half a dozen jobs across three clients; a `STRIPE_API_KEY` env var is one secret with many consumers. Forcing single-ownership ("this agent belongs to *this* project") would fight that — the alternative would be duplicating agents per project just to get them to show up in the right list. Junction tables sidestep that entirely.

| Property | What it gives you |
|---|---|
| **Optional** | A solo install with one workload doesn't need projects at all. The "All Projects" view is the default and shows everything. |
| **Many-to-many** | One agent can be referenced by N projects (or none). Switching projects doesn't move the agent, just the rendered list. |
| **Auto-linking on jobs** | Linking a job pulls in its agent + docs + env vars + databases automatically. You don't have to wire each one separately. |
| **Cheap to delete** | Removing a project drops the junctions. Agents, jobs, docs — all unaffected. |

## A worked example

You're managing two SaaS clients out of one harbour install:

```
Project: Acme
  Agent: Acme Developer
  Job:   Daily PR review
  Doc:   Acme code style
  Env:   ACME_GITHUB_TOKEN

Project: Globex
  Agent: Globex Developer
  Job:   Daily PR review
  Doc:   Globex code style
  Env:   GLOBEX_GITHUB_TOKEN
```

Plus one cross-cutting thing both clients share — an agent named `Researcher` doing weekly market scans. You link it to both projects.

In the sidebar you switch to **Acme**. Agents, Jobs, Docs, Env Vars, Databases, and Runs all narrow to that bag. The waiting-runs badge in the header narrows too — it's a `?projectId=...` query on the runs list.

Switch to **All Projects**. Everything shows up: both Developers, both code style docs, the Researcher (once, not twice), and every run from both. Same data, different view.

Delete the **Acme** project. The five junction rows go. `Acme Developer`, the daily PR job, the Acme doc, the env var — all still present.

## "All Projects" vs. an active project

Active project state is one localStorage key: `harbour_active_project`. The app shell reads it on mount and pipes the value through React context. Pages call `useActiveProjectId()` (or `useProjectFilter()` for the URL-suffix variant) and pass it to their list queries.

What changes between modes:

- **All Projects (no active)** — every list query runs without the `projectId` filter. You see the whole install.
- **Active project** — every list query passes `?projectId=<id>`. The waiting-runs badge, the runs list, the agents list, the docs list, the env vars list, the databases list — all narrow.
- **Stale active id** — if the stored project no longer exists (someone else deleted it from another tab), the shell clears the key and falls back to "All Projects".

Creating new things while in an active project auto-links them. The Add buttons honor the active filter — "+ Job" inside a project creates the job and immediately calls `linkJobToProject` (which also pulls in the job's agent, docs, env vars, databases).

## Auto-linking when you link a job

`linkJobToProject(projectId, jobId)` is the interesting linker. The other linkers (agent, doc, env var, database) are straight `INSERT OR IGNORE` into one junction. Linking a *job* opens a transaction and walks the job's existing references:

1. `INSERT OR IGNORE INTO project_jobs (project_id, job_id)` — the job itself.
2. Look up the job's `agent_id`, link the agent.
3. For every row in `job_docs`, link the doc.
4. For every row in `job_env_vars`, link the env var.
5. For every row in `job_databases`, link the database.

The "Add Existing" job dialog in a project view is where this matters most — pulling in one job populates the whole supporting cast in the project's lists.

It's a one-shot cascade, not a permanent binding. If you later attach a new doc to the job, that doc is *not* automatically linked to the project. The auto-link runs at the moment you call `linkJobToProject`. After that, the linkages drift independently.

## Deletion

`DELETE FROM projects WHERE id = ?` is the whole operation. The cascade: all rows in `project_agents`, `project_jobs`, `project_docs`, `project_env_vars`, `project_databases` for that `project_id` cascade-delete. The referenced entities are untouched.

Everything else — the agents, jobs, docs, env vars, databases — stays exactly where it was. Switching back to "All Projects" you'll see them again.

## API

```
GET    /api/projects                — list projects
POST   /api/projects                — create
GET    /api/projects/:id            — single project
PUT    /api/projects/:id            — rename
DELETE /api/projects/:id            — drop the project (entities unaffected)
PATCH  /api/projects/:id            — link/unlink one entity
```

The PATCH endpoint takes a single body shape:

```json
{ "action": "link" | "unlink",
  "type":   "agent" | "job" | "doc" | "env-var" | "database",
  "targetId": "<entity uuid>" }
```

When `action: "link"` and `type: "job"`, the auto-link cascade above runs.

## What projects intentionally don't do

- **No per-project permissions.** Every signed-in user sees every project. The dashboard is a single-tenant operator console.
- **No project-scoped uniqueness.** Two projects can both reference an agent named "Developer". Names are global — you'd see two agents in the All Projects list and have to keep them named distinctly (`Acme Developer`, `Globex Developer`).
- **No project on entities.** There is no `project_id` column on agents, jobs, docs, env vars, or databases. The junction tables are the only source of truth for "what's in this project." Adding a project_id column would require resolving the multi-project case, which is exactly what the junction shape exists to dodge.
- **No nested projects.** Flat list, alphabetically sorted.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/db/projects.ts` — CRUD plus all linkers; `linkJobToProject` is where the auto-link cascade lives.
- `src/lib/db/schema.ts` — `projects` table plus the five `project_*` junction tables, all with `ON DELETE CASCADE`.
- `src/components/app/app-shell.tsx` — the active-project state machine: localStorage read, stale-id clear.
- `src/lib/hooks/use-project-filter.ts` — `useActiveProjectId()` and `useProjectFilter()` hooks.
- `src/components/app/project-switcher.tsx` — sidebar/mobile dropdown with the create dialog.
- `src/app/api/projects/[id]/route.ts` — the PATCH link/unlink endpoint.
