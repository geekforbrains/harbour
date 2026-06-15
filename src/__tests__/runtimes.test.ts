import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME, isRuntime, RUNTIME_META, RUNTIMES } from "@/lib/runtimes";

describe("runtimes", () => {
  it("RUNTIMES is exactly bash, python, node", () => {
    expect(RUNTIMES).toEqual(["bash", "python", "node"]);
  });

  it("RUNTIME_META has a non-empty label and ext for every runtime", () => {
    for (const runtime of RUNTIMES) {
      const meta = RUNTIME_META[runtime];
      expect(meta).toBeDefined();
      expect(typeof meta.label).toBe("string");
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.ext).toBe("string");
      expect(meta.ext.length).toBeGreaterThan(0);
    }
  });

  it("RUNTIME_META has no entries beyond the supported runtimes", () => {
    expect(Object.keys(RUNTIME_META).sort()).toEqual([...RUNTIMES].sort());
  });

  it("DEFAULT_RUNTIME is one of RUNTIMES", () => {
    expect(RUNTIMES).toContain(DEFAULT_RUNTIME);
  });

  it("isRuntime returns true for each valid runtime", () => {
    for (const runtime of RUNTIMES) {
      expect(isRuntime(runtime)).toBe(true);
    }
  });

  it("isRuntime returns false for invalid values", () => {
    expect(isRuntime("ruby")).toBe(false);
    expect(isRuntime("")).toBe(false);
    expect(isRuntime(null)).toBe(false);
    expect(isRuntime(undefined)).toBe(false);
    expect(isRuntime(123)).toBe(false);
    expect(isRuntime({})).toBe(false);
  });
});
