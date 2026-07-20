import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeLimiter() {
    return createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
  }

  it("allows attempts under the limit", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 4; i++) limiter.record("k");
    expect(limiter.isLimited("k")).toBe(false);
  });

  it("blocks once the limit is reached", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.record("k");
    expect(limiter.isLimited("k")).toBe(true);
  });

  it("an unknown key is never limited", () => {
    const limiter = makeLimiter();
    expect(limiter.isLimited("never-seen")).toBe(false);
  });

  it("window expiry restores access", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.record("k");
    expect(limiter.isLimited("k")).toBe(true);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(limiter.isLimited("k")).toBe(false);
    // And the key gets a fresh window after expiry.
    limiter.record("k");
    expect(limiter.isLimited("k")).toBe(false);
  });

  it("reset clears the counter for a key", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.record("k");
    expect(limiter.isLimited("k")).toBe(true);

    limiter.reset("k");
    expect(limiter.isLimited("k")).toBe(false);
  });

  it("reset with no key clears all counters", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.record("a");
    for (let i = 0; i < 5; i++) limiter.record("b");

    limiter.reset();
    expect(limiter.isLimited("a")).toBe(false);
    expect(limiter.isLimited("b")).toBe(false);
    expect(limiter.size()).toBe(0);
  });

  it("keys are isolated from each other", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.record("a");
    expect(limiter.isLimited("a")).toBe(true);
    expect(limiter.isLimited("b")).toBe(false);
  });

  it("prunes expired entries so the map can't grow unbounded", () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 100; i++) limiter.record(`key-${i}`);
    expect(limiter.size()).toBe(100);

    // After the window passes, the next operation sweeps the dead entries.
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    limiter.record("fresh");
    expect(limiter.size()).toBe(1);
  });
});

describe("clientIp", () => {
  function reqWithHeaders(headers: Record<string, string>) {
    return new Request("http://localhost/", { headers });
  }

  it("returns the last hop of x-forwarded-for (the proxy-appended one)", () => {
    const req = reqWithHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIp(req)).toBe("10.0.0.1");
  });

  it("ignores client-forged leading hops appended to by the proxy", () => {
    // A client sends a fake XFF; the trusted proxy appends the real address.
    const req = reqWithHeaders({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("returns a lone hop as-is", () => {
    const req = reqWithHeaders({ "x-forwarded-for": "203.0.113.7" });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("trims whitespace around the last hop", () => {
    const req = reqWithHeaders({ "x-forwarded-for": "10.0.0.1,  203.0.113.7  " });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when the header is absent or empty", () => {
    expect(clientIp(reqWithHeaders({}))).toBe("unknown");
    expect(clientIp(reqWithHeaders({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});
