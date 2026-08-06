import { describe, expect, it } from "vitest";
import { formatTokens } from "@/lib/format";
import { formatDuration } from "@/lib/time";

// Run-metrics display formatters (feat/run-metrics). Metrics are cumulative
// counters that default to 0 for unmeasured runs — both formatters render 0 as
// an em-dash so run/job surfaces show "no data" rather than a misleading "0s".

describe("formatDuration", () => {
  it("renders 0 and null/undefined as an em-dash (unmeasured run)", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });

  it("renders sub-minute durations as bare seconds", () => {
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(38)).toBe("38s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("rolls to minutes + seconds at exactly 60s", () => {
    expect(formatDuration(60)).toBe("1m 0s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3599)).toBe("59m 59s");
  });

  it("rolls to hours + minutes at exactly 3600s, dropping seconds", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(7500)).toBe("2h 5m");
    expect(formatDuration(7559)).toBe("2h 5m");
  });
});

describe("formatTokens", () => {
  it("renders 0 and null/undefined as an em-dash (no usage reported)", () => {
    expect(formatTokens(0)).toBe("—");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
  });

  it("renders counts under 1000 verbatim", () => {
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("compacts thousands to k with one decimal, trimming .0", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(45_200)).toBe("45.2k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  it("compacts millions to M at exactly 1_000_000", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});
