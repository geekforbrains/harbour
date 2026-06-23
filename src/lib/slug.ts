/**
 * Canonical slug algorithm — the single implementation. Slugs are assigned at
 * creation time from the entity name, are immutable on rename, and serve as
 * filesystem-safe workspace path segments on runner machines
 * (workspaces/<org-slug>/<project-slug>/<agent-slug>).
 *
 * Lowercase the name; replace every run of characters outside [a-z0-9] with a
 * single "-"; trim leading/trailing "-". May produce "" (e.g. emoji-only
 * names) — callers treat empty as an invalid name.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Thrown when a name slugifies to "" (no letters or numbers in it). */
export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNameError";
  }
}

/**
 * Thrown when a new entity's slug collides with a sibling in the same scope.
 * The message is user-facing: it names the colliding entity and explains the
 * non-obvious lookalike case ("Dev Agent" vs "Dev_Agent" share a slug).
 */
export class NameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameCollisionError";
  }
}
