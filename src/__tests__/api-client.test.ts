import { describe, expect, it } from "vitest";
import { ApiError, scoped, shouldRetryQuery } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";

describe("shouldRetryQuery()", () => {
  it("never retries a 4xx — these are not transient (the stale-scope 403 hang)", () => {
    for (const status of [400, 401, 403, 404, 422, 499]) {
      expect(shouldRetryQuery(0, new ApiError(status, null))).toBe(false);
    }
  });

  it("retries 5xx up to three attempts", () => {
    const err = new ApiError(500, null);
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(2, err)).toBe(true);
    expect(shouldRetryQuery(3, err)).toBe(false);
  });

  it("retries non-ApiError failures (network/parse blips) up to three attempts", () => {
    const err = new Error("network down");
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(3, err)).toBe(false);
  });
});

describe("scoped()", () => {
  it("returns the path unchanged when no scope is given", () => {
    expect(scoped("/api/runs")).toBe("/api/runs");
    expect(scoped("/api/runs", {})).toBe("/api/runs");
    expect(scoped("/api/runs", { orgId: null, projectId: null })).toBe("/api/runs");
  });

  it("appends orgId only", () => {
    expect(scoped("/api/runs", { orgId: "o1" })).toBe("/api/runs?orgId=o1");
  });

  it("appends both orgId and projectId", () => {
    expect(scoped("/api/runs", { orgId: "o1", projectId: "p1" })).toBe(
      "/api/runs?orgId=o1&projectId=p1",
    );
  });

  it("appends projectId only", () => {
    expect(scoped("/api/agents", { projectId: "p1" })).toBe("/api/agents?projectId=p1");
  });

  it("preserves an existing query string", () => {
    expect(scoped("/api/agents?limit=5", { projectId: "p1" })).toBe(
      "/api/agents?limit=5&projectId=p1",
    );
  });

  it("ignores nullish scope values", () => {
    expect(scoped("/api/runs", { orgId: undefined, projectId: "p1" })).toBe(
      "/api/runs?projectId=p1",
    );
  });
});

describe("qk factory", () => {
  it("exposes stable domain prefixes", () => {
    expect(qk.runs.all).toEqual(["runs"]);
    expect(qk.agents.all).toEqual(["agents"]);
    expect(qk.docs.all).toEqual(["docs"]);
    expect(qk.envVars.all).toEqual(["env-vars"]);
  });

  it("carries the scope id in the list-key tail", () => {
    const key = qk.runs.list({ orgId: "o1", projectId: "p1" });
    expect(key[0]).toBe("runs");
    expect(key[key.length - 1]).toEqual({ orgId: "o1", projectId: "p1" });
  });

  it("normalizes missing scope to nulls so identity is by value", () => {
    expect(qk.docs.list()).toEqual(["docs", "list", { orgId: null, projectId: null }]);
    expect(qk.docs.list({})).toEqual(["docs", "list", { orgId: null, projectId: null }]);
  });

  it("nests detail keys under the domain prefix for prefix invalidation", () => {
    const detail = qk.agents.detail("a1");
    expect(detail.slice(0, 1)).toEqual(["agents"]);
    expect(detail).toContain("a1");
  });
});
