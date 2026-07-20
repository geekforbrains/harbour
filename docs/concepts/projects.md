# Projects

Projects are Harbour's **organization**, not a tenancy or permission boundary.
The hierarchy is flat: instance → **projects** → agents & jobs → runs. Every
agent, job, run, doc, secret, and table lives inside exactly one project, and
every authenticated user sees and can operate all of them — a project is a
grouping that keeps one stream of work filterable, nothing more.

## The hierarchy

- **Instance** — the install itself. The first user is created from the shell
  (`harbour setup`); further users are invited from the dashboard. There are no
  roles, no memberships, and no admin flag — every user can do everything.
- **Project** — groups the actual work. `slug` is unique instance-wide and is
  the workspace path segment (see below).

## What lives where

One ownership shape (full columns in
[database-schema.md](../reference/database-schema.md)): `agents`, `jobs`,
`runs`, `docs`, `env_vars`, and `tables` all carry a NOT NULL `project_id`
referencing `projects` with `ON DELETE CASCADE`. Belonging to a project *is*
the `project_id` column, not a linking row. The only junction tables are the
job-linked ones (`job_docs`, `job_env_vars`, `job_tables`) — and those links
may cross projects freely (see [shared context](shared-context.md)).

## Filtering by project

The active project lives in `localStorage["harbour_active_project"]` —
`null` means **all projects**. `AppShell` reads it and pipes it through React
context; list pages pass `?projectId=` to their queries, and omitting it
returns the union across every project (list payloads carry a `project_name`
so rows stay attributable). Switching invalidates all React Query keys so
every list refetches in the new scope. A stale active id (project deleted from
another tab) is cleared on mount.

Creating something while a project is active scopes it there — "+ Agent" /
"+ Job" sets the new row's `project_id`.

## Deletion

Project delete is a **hard delete**: the row goes, and the cascade follows the
`project_id` FKs — the project's agents, jobs, runs, docs, secrets, and tables
all go with it. There is no archive state and no undo.

One caveat worth knowing: deleting a project frees its slug, but runner
machines keep the old workspace directories
(`~/.harbour/workspaces/<project-slug>/<agent-slug>/`) — disk cleanup is
manual. A later project created with the same name takes the same slug and
will **reuse** those leftover directories, inheriting whatever filesystem
state the old agents left behind. Clean up the old tree first if that matters.

## What projects don't do

- **No access control.** A project never hides anything from anyone — every
  user (and every API key) reaches every project.
- **No nesting.** One flat list.
- **No multi-project entities.** An agent or job belongs to exactly one
  project (the direct FK). Sharing across projects is done by **linking** —
  a job may link docs, secrets, and tables from any project.

## Source-of-truth pointers

- `src/lib/db/schema.ts` — `projects` and the `project_id` columns on entities
  and resources.
- `src/lib/db/projects.ts` — project CRUD and the hard-delete cascade.
- `src/lib/auth.ts` — `withAuthenticatedUser` and friends (no roles anywhere).
- `src/components/app/app-shell.tsx` — active-project state.
- `src/lib/hooks/use-project-filter.ts` — the scope hooks.
- `src/components/app/project-switcher.tsx` — the project dropdown.
