# Cutting a release

Releases are manual. `npm run release` only rebuilds and bounces the local stack
(macOS/launchd) — it does **not** create a version. A release is a single commit
touching three files, then a tag.

For a release `vX.Y.Z`:

1. Add a section at the top of [`changelog.md`](../../changelog.md) matching the
   existing style: `## vX.Y.Z — YYYY-MM-DD`, then one or more `### <Topic>`
   subheads with human-readable bullets (not raw commit subjects).
2. Bump `package.json` and `package-lock.json` together:
   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```
3. Commit — this commit touches **only** the three files above:
   ```bash
   git add changelog.md package.json package-lock.json
   git commit -m "chore: release vX.Y.Z"
   ```
4. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push && git push origin vX.Y.Z
   ```

## Version bumps

- **Patch** (v1.11.0 → v1.11.1) — bug fixes only
- **Minor** (v1.10.1 → v1.11.0) — new features, backwards-compatible
- **Major** — breaking changes (none cut so far)
