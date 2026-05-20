import { describe, it, expect } from "vitest";
import { shouldContinueEagerLoop, EAGER_MAX_ITERATIONS } from "../../bin/lib/runner.mjs";

describe("shouldContinueEagerLoop", () => {
  it("never loops when eager is off", () => {
    for (const outcome of ["done", "waiting", "skipped", "failed", "killed", "no-work", "poll-error"]) {
      expect(shouldContinueEagerLoop(outcome, false)).toBe(false);
    }
  });

  it("continues on clean outcomes when eager is on", () => {
    expect(shouldContinueEagerLoop("done", true)).toBe(true);
    expect(shouldContinueEagerLoop("waiting", true)).toBe(true);
    expect(shouldContinueEagerLoop("skipped", true)).toBe(true);
  });

  it("exits on failure when eager is on (lets 60s gap absorb transients)", () => {
    expect(shouldContinueEagerLoop("failed", true)).toBe(false);
  });

  it("exits on kill when eager is on (user said stop)", () => {
    expect(shouldContinueEagerLoop("killed", true)).toBe(false);
  });

  it("exits on no-work / poll-error regardless of eager flag", () => {
    expect(shouldContinueEagerLoop("no-work", true)).toBe(false);
    expect(shouldContinueEagerLoop("no-work", false)).toBe(false);
    expect(shouldContinueEagerLoop("poll-error", true)).toBe(false);
    expect(shouldContinueEagerLoop("poll-error", false)).toBe(false);
  });

  it("treats unknown outcomes as exit-worthy (defensive)", () => {
    expect(shouldContinueEagerLoop("running", true)).toBe(false);
    expect(shouldContinueEagerLoop("garbage", true)).toBe(false);
    expect(shouldContinueEagerLoop("", true)).toBe(false);
  });

  it("exposes a sane iteration cap", () => {
    expect(EAGER_MAX_ITERATIONS).toBeGreaterThanOrEqual(10);
    expect(EAGER_MAX_ITERATIONS).toBeLessThanOrEqual(1000);
  });
});
