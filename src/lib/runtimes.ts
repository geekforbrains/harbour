// The runtimes a job's prerun / postrun / workflow script can be authored in.
//
// A gate is a gist: a `runtime` plus a `content` body. The web side uses this
// module to drive the editor dropdown and validate API input; the runner
// (bin/lib/runner.mjs) keeps its own parallel map of how to *execute* each
// runtime (interpreter + file extension) because it's a standalone .mjs that
// can't import TypeScript. Keep the two in sync — the set here is the source
// of truth for what's allowed; the runner mirrors how to run it.

export const RUNTIMES = ["bash", "python", "node"] as const;

export type Runtime = (typeof RUNTIMES)[number];

/** Display label + materialized-file extension for each runtime. */
export const RUNTIME_META: Record<Runtime, { label: string; ext: string }> = {
  bash: { label: "Bash", ext: "sh" },
  python: { label: "Python", ext: "py" },
  node: { label: "Node.js", ext: "js" },
};

/** The runtime assumed when a gate has a body but no explicit runtime. */
export const DEFAULT_RUNTIME: Runtime = "bash";

/** Narrowing guard: is `value` one of the supported runtimes? */
export function isRuntime(value: unknown): value is Runtime {
  return typeof value === "string" && (RUNTIMES as readonly string[]).includes(value);
}

/** A job gate: pick a runtime, write the body. */
export type Gate = {
  runtime: Runtime;
  content: string;
};
