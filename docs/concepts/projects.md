# Orgs & projects

Orgs and projects are Harbour's **tenancy**, not an optional view filter. An
instance admin owns the install; work is organized into **orgs → projects**; and
every agent, job, and run lives inside exactly one project. Projects are where
operational entities are born and scoped.

## The hierarchy

- **Instance admin** — created from the shell (`harbour setup`); owns the
  install and spans every org. Stored as `users.is_instance_admin`.
- **Org** — the tenant boundary. A user joins an org through a `memberships` row
  carrying a role (`editor` or `viewer`). **Resources never cross org lines.**
- **Project** — groups the actual work within an org.

Roles resolve per org (`src/lib/db/access.ts`): a **viewer** reads, an **editor**
changes things, and an **instance admin** satisfies any check in any org.

## What lives where

Two ownership shapes (full columns in
[database-schema.md](../reference/database-schema.md)):

- **Operational entities** — `agents`, `jobs`, `runs` — carry a NOT NULL
  `project_id`. An agent belongs to one project; deleting the project cascades
  them away.
- **Resources** — `docs`, `env_vars` (Secrets), `databases` — are **dual-tier**:
  a NOT NULL `org_id` plus a nullable `project_id`. `project_id IS NULL` means
  **org-level** (usable by every project in the org); otherwise **project-level**.
  See [shared context](shared-context.md).

There are **no** `project_*` junction tables (v1 had them). Belonging to a
project *is* the `project_id` column, not a linking row. The only junction tables
left are the job-linked ones (`job_docs`, `job_env_vars`, `job_databases`).

## Switching org & project

The active org lives in the `harbour_org` cookie (set by the org switcher); the
active project in `localStorage["harbour_active_project"]`. `AppShell` reads both
and pipes them through React context; list pages pass `?orgId=` / `?projectId=`
to their queries. Switching either invalidates all React Query keys so every list
refetches in the new scope. A stale active id (project deleted from another tab)
is cleared on mount.

Creating something while a project is active scopes it there — "+ Agent" /
"+ Job" sets the new row's `project_id`.

## Deletion

Projects soft-delete (`archived_at`) on the normal path; a hard delete is the
admin escape hatch. Either way the cascade follows the `project_id` FKs — the
project's agents, jobs, and runs go with it. Org-level resources
(`project_id IS NULL`) are untouched; project-level resources in that project
cascade.

## What projects don't do

- **No cross-org references.** A resource in org A can never be used by org B.
- **No nesting.** Flat list within an org.
- **No multi-project entities.** An agent or job belongs to exactly one project
  (the direct FK). Sharing *within* an org is done at the **org level** — an
  org-level doc / secret / database is visible to every project in the org —
  not by referencing one entity from many projects.

## Source-of-truth pointers

- `src/lib/db/schema.ts` — `orgs`, `memberships`, `projects`, and the `org_id` /
  `project_id` columns on entities and resources.
- `src/lib/db/access.ts` — role resolution (`resolveAccess`, `meets`) and the
  `orgIdFor*` hierarchy walkers.
- `src/lib/auth.ts` — `withOrgAuth` / `withProjectAuth` / `withResourceAuth`.
- `src/components/app/app-shell.tsx` — active org/project state.
- `src/lib/hooks/use-project-filter.ts` — the scope hooks.
- `src/components/app/project-switcher.tsx` — the org and project dropdowns.
