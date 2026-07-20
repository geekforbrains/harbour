# Cutting a release

Releases are manual. `npm run release` only rebuilds and bounces the local stack
(macOS/launchd) — it does **not** create a version, tag, or GitHub Release.

Harbour cuts public releases from `main`. Day-to-day work lands on `dev`; when
`dev` is ready, prepare the version there, merge it to `main`, tag the `main`
merge commit, then create the matching GitHub Release. The version, tag, and
GitHub Release title are the same string: `vX.Y.Z`.

## Preflight

1. Sync branch and tag refs:
   ```bash
   git fetch origin --tags
   ```
2. Start from `dev` with no unrelated working-tree changes. If the tree is not
   clean, identify whether those changes are part of the release before
   continuing:
   ```bash
   git checkout dev
   git status --short --branch
   git log --oneline main..dev
   ```
3. Choose the next version from the rules below. For a breaking cut, use a
   major release, not another minor.

## Release prep on `dev`

For a release `vX.Y.Z`, create one release-prep commit on `dev`:

1. Add a section at the top of [`changelog.md`](../../changelog.md) matching the
   existing style: `## vX.Y.Z — YYYY-MM-DD`, then one or more `### <Topic>`
   subheads with human-readable bullets (not raw commit subjects).
   For a major release with breaking changes, call them out explicitly —
   Harbour has no schema migrations, so a schema-breaking release means a
   fresh database, and the changelog should say so.
2. Bump [`package.json`](../../package.json) and
   [`package-lock.json`](../../package-lock.json) together:
   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```
3. Run the validation ladder from
   [development standards](../reference/development-standards.md#validation-commands).
4. Commit — this commit touches **only** the three files above:
   ```bash
   git add changelog.md package.json package-lock.json
   git commit -m "chore: release vX.Y.Z"
   ```
5. Push `dev`:
   ```bash
   git push origin dev
   ```

## Merge, tag, and publish

1. Merge `dev` into `main` with a release-shaped merge commit:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git merge --no-ff dev -m "Merge dev: vX.Y.Z — <short release summary>"
   ```
2. Re-run the validation ladder on `main`. Do not tag a commit that has not
   passed validation on the branch being released.
3. Tag the `main` merge commit and push `main` plus the tag:
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
4. Create the GitHub Release from the tag. Use the matching changelog section as
   the release notes; mark beta/RC tags as prereleases:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/harbour-vX.Y.Z-notes.md
   # For beta/RC tags:
   gh release create vX.Y.Z-beta.N --prerelease --title "vX.Y.Z-beta.N" --notes-file /tmp/harbour-vX.Y.Z-beta.N-notes.md
   ```
5. Fast-forward `dev` to the released `main` so the next cycle starts from the
   tagged merge commit:
   ```bash
   git checkout dev
   git merge --ff-only main
   git push origin dev
   ```

## Version bumps

- **Patch** (v1.11.0 → v1.11.1) — bug fixes only
- **Minor** (v1.10.1 → v1.11.0) — new features, backwards-compatible
- **Major** (v1.x → v2.0.0) — breaking changes, including sunsetting v1
- **Prerelease** (v2.0.0-beta.1 → v2.0.0-beta.2) — beta/RC cuts before an
  official release; create the GitHub Release with `--prerelease`
