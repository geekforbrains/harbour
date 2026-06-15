import { describe, expect, it } from "vitest";
// The runner is a standalone .mjs that can't import the TS runtimes module, so
// it keeps its own RUNTIME_EXEC/RUNTIME_EXT maps. This test is the enforcement
// behind src/lib/runtimes.ts's "keep the two in sync" comment: if either side
// gains/loses a runtime or an extension drifts, this fails instead of shipping
// a payload the runner can't execute.
import { RUNTIME_EXEC, RUNTIME_EXT } from "../../bin/lib/runner.mjs";
import { RUNTIME_META, RUNTIMES } from "../lib/runtimes";

describe("runtime map parity (src/lib/runtimes.ts ↔ bin/lib/runner.mjs)", () => {
  it("the runner knows how to execute exactly the supported runtimes", () => {
    expect(Object.keys(RUNTIME_EXEC).sort()).toEqual([...RUNTIMES].sort());
    expect(Object.keys(RUNTIME_EXT).sort()).toEqual([...RUNTIMES].sort());
  });

  it("file extensions agree between the web side and the runner", () => {
    for (const runtime of RUNTIMES) {
      expect(RUNTIME_EXT[runtime]).toBe(RUNTIME_META[runtime].ext);
    }
  });

  it("every runtime maps to a non-empty interpreter binary", () => {
    for (const runtime of RUNTIMES) {
      expect(typeof RUNTIME_EXEC[runtime]).toBe("string");
      expect(RUNTIME_EXEC[runtime].length).toBeGreaterThan(0);
    }
  });
});
