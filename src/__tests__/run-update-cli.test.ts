import { describe, expect, it } from "vitest";
import {
  buildUpdateRequest,
  parseUpdateArgs,
  runUpdate,
  UPDATE_FIELDS,
} from "../../bin/lib/update-cli.mjs";

// `harbour update {status,title,log}` is the reporting channel an enforced
// agent uses instead of curl. It exists so a permission policy can allow
// reporting — one narrow rule, `Bash(harbour update *)` — without granting the
// general network access `Bash(curl *)` would. It reads the run's identity and
// credential from the environment the runner injects, never from arguments, so
// nothing run-scoped leaks into the command line or the transcript.

const ENV = {
  HARBOUR_URL: "http://127.0.0.1:4272",
  HARBOUR_RUN_ID: "run-123",
  HARBOUR_API_KEY: "hbx_secret",
};

describe("parseUpdateArgs", () => {
  it("takes the field and the rest of argv as the value", () => {
    expect(parseUpdateArgs(["status", "done"])).toEqual({
      ok: true,
      field: "status",
      value: "done",
    });
  });

  it("joins a multi-word value so an unquoted message still works", () => {
    // `harbour update log Fetched the site` — the shell splits it; rejoining
    // beats failing on a missing quote the model forgot.
    expect(parseUpdateArgs(["log", "Fetched", "the", "site"])).toEqual({
      ok: true,
      field: "log",
      value: "Fetched the site",
    });
  });

  it("accepts every documented field", () => {
    for (const field of UPDATE_FIELDS) {
      expect(parseUpdateArgs([field, "x"]).ok, field).toBe(true);
    }
  });

  it("rejects an unknown field, naming the valid ones", () => {
    const parsed = parseUpdateArgs(["staus", "done"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("status");
  });

  it("rejects a missing field or empty value", () => {
    expect(parseUpdateArgs([]).ok).toBe(false);
    expect(parseUpdateArgs(["status"]).ok).toBe(false);
    expect(parseUpdateArgs(["title", "   "]).ok).toBe(false);
  });
});

describe("buildUpdateRequest", () => {
  it("maps status to the run status endpoint", () => {
    expect(buildUpdateRequest("status", "done", ENV)).toEqual({
      ok: true,
      method: "PUT",
      url: "http://127.0.0.1:4272/api/runs/run-123/status",
      body: { status: "done" },
      token: "hbx_secret",
    });
  });

  it("maps title to the title endpoint", () => {
    const req = buildUpdateRequest("title", "Checked the site", ENV);
    expect(req).toMatchObject({ ok: true, method: "PUT", body: { title: "Checked the site" } });
    if (req.ok) expect(req.url).toMatch(/\/api\/runs\/run-123\/title$/);
  });

  it("maps log to an activity POST — the stream is appended, not replaced", () => {
    const req = buildUpdateRequest("log", "working on it", ENV);
    expect(req).toMatchObject({ ok: true, method: "POST", body: { content: "working on it" } });
    if (req.ok) expect(req.url).toMatch(/\/api\/runs\/run-123\/activity$/);
  });

  it("trims a trailing slash on the base URL rather than doubling it", () => {
    const req = buildUpdateRequest("status", "done", { ...ENV, HARBOUR_URL: "http://h.test/" });
    if (req.ok) expect(req.url).toBe("http://h.test/api/runs/run-123/status");
  });

  it("rejects a status value the run lifecycle doesn't define", () => {
    const req = buildUpdateRequest("status", "finished", ENV);
    expect(req.ok).toBe(false);
    if (!req.ok) expect(req.error).toContain("done");
  });

  it("accepts every status an agent may legitimately set", () => {
    for (const status of ["done", "failed", "waiting", "skipped"]) {
      expect(buildUpdateRequest("status", status, ENV).ok, status).toBe(true);
    }
  });

  it("fails with an actionable message when the run environment is absent", () => {
    // The usual cause is running the command outside a run — say, by hand in a
    // terminal — so the error names the variables rather than 401ing later.
    const req = buildUpdateRequest("status", "done", {});
    expect(req.ok).toBe(false);
    if (!req.ok) {
      expect(req.error).toContain("HARBOUR_RUN_ID");
      expect(req.error).toContain("inside an agent run");
    }
  });

  it("does not leak the token into the error when only the url is missing", () => {
    const req = buildUpdateRequest("status", "done", {
      HARBOUR_RUN_ID: "r",
      HARBOUR_API_KEY: "hbx_x",
    });
    expect(req.ok).toBe(false);
    if (!req.ok) expect(req.error).not.toContain("hbx_x");
  });
});

describe("runUpdate", () => {
  function fakeFetch(response: { ok: boolean; status?: number; text?: string }) {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const fn = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 400),
        text: async () => response.text ?? "",
      };
    };
    return { fn, calls };
  }

  it("sends the request with bearer auth and exits 0", async () => {
    const { fn, calls } = fakeFetch({ ok: true });
    const logs: string[] = [];
    const code = await runUpdate(["status", "done"], {
      env: ENV,
      fetch: fn,
      log: (m: string) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:4272/api/runs/run-123/status");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer hbx_secret",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ status: "done" });
  });

  it("exits non-zero and reports the server's error body", async () => {
    const { fn } = fakeFetch({ ok: false, status: 400, text: '{"error":"illegal transition"}' });
    const errors: string[] = [];
    const code = await runUpdate(["status", "done"], {
      env: ENV,
      fetch: fn,
      error: (m: string) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join(" ")).toContain("illegal transition");
  });

  it("exits non-zero on a network failure without throwing", async () => {
    const errors: string[] = [];
    const code = await runUpdate(["log", "hi"], {
      env: ENV,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      error: (m: string) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join(" ")).toContain("ECONNREFUSED");
  });

  it("never prints the token, even on failure", async () => {
    const { fn } = fakeFetch({ ok: false, status: 401, text: "unauthorized" });
    const out: string[] = [];
    await runUpdate(["status", "done"], {
      env: ENV,
      fetch: fn,
      log: (m: string) => out.push(m),
      error: (m: string) => out.push(m),
    });
    expect(out.join(" ")).not.toContain("hbx_secret");
  });

  it("rejects bad arguments before making any request", async () => {
    const { fn, calls } = fakeFetch({ ok: true });
    const code = await runUpdate(["nonsense", "x"], { env: ENV, fetch: fn, error: () => {} });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
