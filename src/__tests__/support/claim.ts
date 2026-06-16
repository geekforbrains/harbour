// Shared test support for the unified Runner Protocol claim. Lives outside the
// *.test.ts glob so vitest doesn't run it as a suite.

import { type ClaimRunner, claimNextRun, createRunner, peekClaim } from "@/lib/db/queries";
import type { RunnerCapabilities, RunnerScope, RunnerTier } from "@/lib/db/runners";

/** A runner that can run everything the bundled local runner can. */
export const ALL_CAPS: RunnerCapabilities = {
  kinds: ["agent", "workflow"],
  clis: ["claude", "codex", "gemini"],
  labels: ["local"],
};

/** Just the workflow kind (no CLIs) — a workflow-only runner. */
export const WORKFLOW_CAPS: RunnerCapabilities = {
  kinds: ["workflow"],
  clis: [],
  labels: ["local"],
};

/**
 * Register a runner row and return the {@link ClaimRunner} the claim path wants.
 * Defaults to the trusted local tier with no scope, matching the bundled runner.
 */
export function localRunner(
  opts: { name?: string; tier?: RunnerTier; labels?: string[]; scope?: RunnerScope } = {},
): ClaimRunner & { token: string } {
  const r = createRunner({
    name: opts.name ?? "Local pool",
    tier: opts.tier ?? "local",
    labels: opts.labels,
    scope: opts.scope ?? null,
  });
  return { id: r.id, tier: r.tier, labels: r.labels, scope: r.scope, token: r.token };
}

/** Claim with the given (or a fresh local) runner advertising all capabilities. */
export function claim(runner?: ClaimRunner, caps: RunnerCapabilities = ALL_CAPS) {
  return claimNextRun(runner ?? localRunner(), caps);
}

/** Peek with the given (or a fresh local) runner advertising all capabilities. */
export function peek(runner?: ClaimRunner, caps: RunnerCapabilities = ALL_CAPS) {
  return peekClaim(runner ?? localRunner(), caps);
}
