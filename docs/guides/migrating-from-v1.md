# Migrating from v1

Harbour v2 is a clean-break rewrite: the database has a different shape and there is **no in-place upgrade** (the server refuses to boot against a v1 database). Moving over means a *fresh install* of v2 plus a one-time **translation** of your old data into the new structure.

The path is: back up `~/.harbour`, wipe it, install v2 fresh, then run `harbour migrate` pointed at the backup. The `migrate` command does the structural translation for you — it reads the old database directly, re-keys your secrets, and writes everything in v2's shape.

> This page is written to be run top-to-bottom by a person **or** by an agent. If you're pointing Claude (or another agent) at it: read the whole thing, run the **dry run** first and report the plan back, then do the real run. Everything is reversible until you delete the backup.

## What moves, what doesn't

| Carried over | Dropped |
|---|---|
| Agents (CLI, model, thinking, placement) | Run history + run activity/output |
| Jobs — agent, workflow, and combo (→ prerun gate) | Run attachments + the `uploads/` directory |
| Workflows | One-off jobs (they've already fired) |
| Docs (latest content) | Doc revision *history* (latest revision is kept) |
| Secrets / env vars (re-encrypted under the new key) | Table *migration history* (the data is kept) |
| Tables + all their rows | Login sessions |
| Projects (as real projects under one org) | Passwords (re-set via a link — see below) |
| Admin API keys (keep working — same hashing) | |
| Instance timezone | |

Runs are intentionally not migrated — v2's run lifecycle differs and old runs carry no forward value. Everything you *configure* comes across; the execution log does not.

## How the structure maps

v1 was flat (global agents/jobs/docs/secrets, with optional groupings). v2 is **org → project → agents/jobs**, with docs/secrets/tables that live at either the org or a project. The migrator bridges that:

- **One org** is created for the whole install (v1 had no orgs). Name it with `--org`.
- **Each v1 project becomes a v2 project** under that org. Agents that were in **no** project land in a `Default` project; an agent that was in **several** projects lands in the first one (and the migrator warns).
- **Docs, secrets, and tables** that belonged to exactly one project become *project-level* there; anything shared across projects (or none) becomes *org-level*.
- **Job shapes** translate: a workflow-only job → a v2 **workflow**; an agent job with a check command → an agent job with a **prerun gate**; a plain agent job stays an agent job.
- **External (API-key) agents** come across as agents with no CLI. They have no runner in v2 — assign them a CLI or reconnect them over the [runner protocol](run-on-different-machine.md). The migrator warns for each.
- **Remote agents** keep running elsewhere: they're migrated with `placement: remote`, so you'll point a remote runner at them as in [running on a different machine](run-on-different-machine.md).

## Before you start

- **Node 24 LTS.** Same requirement as a normal install.
- **Stop v1** — both the server and the runner — so nothing writes to the database mid-backup.

```bash
# stop the v1 runner service if you scheduled one, then the server
npm run harbour -- agent uninstall   # v1 runner (ignore if you never installed it)
# …and stop the v1 server process
```

## The migration

### 1. Back up and clear `~/.harbour`

```bash
cp -a ~/.harbour ~/.harbour-v1-backup    # full snapshot: db, encryption key, uploads
rm -rf ~/.harbour                        # start v2 from a clean home
```

The backup is your source of truth for the migration **and** your rollback. Don't delete it until you've verified v2.

### 2. Install v2 and create the admin

Pull the v2 code into your Harbour checkout, then:

```bash
npm install
npm run build
npm run harbour -- setup     # creates the instance admin + local runner
```

`setup` is interactive. For a scripted install use `npm run harbour -- admin create --email <e> --name "<n>" --password <p>` (password must be 12+ characters).

### 3. Boot the server once

The full v2 schema and the install's encryption key are created the **first time the server boots** — not by `setup`. So start it once:

```bash
npm start
```

Leave it running (you'll want it up to verify anyway). If you skip this, `migrate` stops with a clear message telling you to do it.

### 4. Dry-run the migration

The dry run does the entire translation in a transaction and then **rolls it back** — nothing is written. It prints exactly what would be created and every warning. Run it, read it:

```bash
npm run harbour -- migrate --from ~/.harbour-v1-backup --org "My Org" --dry-run
```

You'll get a per-entity count and warnings for the lossy/ambiguous cases (multi-project agents, external agents, unparseable schedules, password-less users, skipped tier-mismatched links). If anything looks wrong, stop here — nothing has changed.

### 5. Run it for real

```bash
npm run harbour -- migrate --from ~/.harbour-v1-backup --org "My Org"
```

It asks for confirmation (pass `--yes` to skip the prompt). The whole migration is one transaction — if anything fails, it rolls back and your fresh install is untouched. It only runs against a fresh install (it refuses if the org already exists), so you can't double-migrate.

Flags: `--from <dir>` (default `~/.harbour-v1-backup`), `--org "<name>"` (default `Default`), `--dry-run`, `--yes`, `--db <path>` (defaults to this install's database).

### 6. Verify, then schedule the runner

Refresh the dashboard — you should see your org, projects, agents, jobs, docs, secrets, and tables. **Before you rely on it, work through [Spot-check every job](#spot-check-every-job) and [Reconcile workspaces & clean up](#reconcile-workspaces--clean-up) below** — the migrator preserves what's linked, but a few access mechanisms moved. Then schedule the local runner to start claiming work:

```bash
npm run harbour -- install   # polls every 60s
```

## After migrating

The migration brings your configuration across, but a few things need a human (or agent) pass before you rely on it.

### Accounts & access

- **Passwords.** v1 password hashes can't be reused (v1 used bcrypt, v2 uses argon2id). Migrated users come in with no password — from **Settings → Users**, send each one a set-password link. The instance admin you created in step 2 is unaffected; if a v1 user had that same email, it's reused, not duplicated.
- **External agents** show up with no CLI. Give them a CLI/model in the dashboard, or reconnect them as remote runners.
- **Remote agents** are migrated as `placement: remote` — re-point their runner at the v2 server (see [running on a different machine](run-on-different-machine.md)).
- **Admin API keys** keep working unchanged — the same key string authenticates against v2.

### Spot-check every job

The migrator preserves *what's linked to a job*, but a few of the mechanisms an agent uses to *reach* that context changed between v1 and v2. Stale instructions don't error — they just quietly do the wrong thing. So walk every migrated job, re-read its instructions (and any prerun script), and confirm each of the following still holds:

- **Tables (v1 called them "databases").** Renamed end to end: the API is now `POST/GET /api/tables/:id/rows` (was `/api/databases/...`), read with `read_rows` and written with `insert_rows`, both **targeted by the table's `id`**. The migration **regenerated both** the table's `id` and its physical SQLite table name. So any instruction or script that hardcodes a database **id**, a physical table name (e.g. `t_leads`), or an `/api/databases/...` URL is now wrong — update it. Referencing a table by its **logical name** still works (the run payload keys `tables` by name). Also confirm the table is still **linked** to the job (see the tier note below).
- **Secrets / env vars.** Access is unchanged — linked secrets are injected as real environment variables, so `$MY_SECRET` still expands both in the agent's shell and in gate scripts. (New in v2: gate scripts now get the secrets too; in v1 they didn't.) The thing to verify is the **link**: if the migrator warned it skipped a job→secret link, a `$VAR` the instructions depend on may now be unset.
- **Prerun gates (v1 "combo" jobs).** A v1 job with a check command is now an agent job with a **prerun gate** (`bash`). The exit-code contract is identical — `0` continue, `77` skip the run, anything else fail — but *where* it runs changed: the gate body is materialized to a file and run from a **per-job scripts directory** (`$HARBOUR_HOME/workflows/<…>`), not one shared `workflows/` dir, with the job's secrets in its environment and the run payload on **stdin**. It does **not** run in the agent's workspace. A gate that assumed the shared dir, left state for another job to read, or `cd`'d into the agent's repo needs rethinking; simple checks (`test -f …`, an HTTP probe) are unaffected.
- **Instructions that name the old world.** Skim for v1-isms that no longer exist: "database" (now "table"), per-agent API keys, or absolute paths under the old flat `~/.harbour/workspaces/<agent>/`. Reword them for the v2 layout.

> **Why links can be missing:** v2 resources are tiered (org-level or one project). A job may link an org-level resource, or one in *its own* project; an org-level workflow can only link org-level resources. Where a v1 link broke that rule the migrator skipped it and warned — re-link from the dashboard, or promote the resource to org-level.

### Reconcile workspaces & clean up

v2 nests each agent's workspace at **`~/.harbour/workspaces/<org>/<project>/<agent>/`** (v1 was flat: `~/.harbour/workspaces/<agent>/`). The runner creates a fresh, empty directory at the new path — it does **not** find your old one. The migration prints an **old → new** map for every agent that had a populated v1 workspace (git repos are flagged). For each, move or re-clone the repo into the new path before the agent runs:

```bash
mkdir -p ~/.harbour/workspaces/<org>/<project>/<agent>
# move the existing copy…
mv ~/.harbour-v1-backup/workspaces/<agent>/. ~/.harbour/workspaces/<org>/<project>/<agent>/
# …or, cleaner for a git repo, re-clone fresh at the new path instead
```

Harbour's model is that **an agent only ever works inside its own workspace**. Make sure each agent's repo and tooling live at the new path, and that nothing it depends on sits outside.

> **If you're an agent running this migration:** don't move repos silently. Show the user the old → new map and **ask how to handle each** — `mv` the existing copy, or re-clone fresh (preferred for git repos, so nothing stale carries over). While you're there, offer the cleanup the new layout invites: deleting anything left at the old flat paths once moves are confirmed, removing now-defunct per-agent API keys, consolidating docs/secrets that were duplicated per-project but could be org-level, and splitting a multi-project agent the migrator collapsed into a single project. Make these changes only with the user's say-so.

## Rollback

Nothing destructive happens to your old data — it's all in `~/.harbour-v1-backup`. To go back to v1:

```bash
rm -rf ~/.harbour
cp -a ~/.harbour-v1-backup ~/.harbour
```

…then check out the v1 code and start it as before. Once v2 is verified and you're happy, delete the backup.
