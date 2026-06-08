import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runWorkflow, workflowOutcome, processNextWorkflow } from "../../bin/lib/runner.mjs";

// ---------------------------------------------------------------------------
// workflowOutcome: pure exit-code -> terminal-status mapping, including the
// kill-race guard (a late kill must not clobber a command that exited cleanly).
// ---------------------------------------------------------------------------
describe("workflowOutcome", () => {
  it("maps a clean exit (0) to done", () => {
    expect(workflowOutcome({ killed: false, code: 0 })).toBe("done");
  });
  it("maps exit 77 to skipped", () => {
    expect(workflowOutcome({ killed: false, code: 77 })).toBe("skipped");
  });
  it("maps any other non-zero exit to failed", () => {
    expect(workflowOutcome({ killed: false, code: 1 })).toBe("failed");
    expect(workflowOutcome({ killed: false, code: 3 })).toBe("failed");
  });
  it("maps a kill that terminated the process (non-clean exit) to killed", () => {
    expect(workflowOutcome({ killed: true, code: null })).toBe("killed");
    expect(workflowOutcome({ killed: true, code: 143 })).toBe("killed");
  });
  it("does NOT clobber a clean exit when a kill lands in the race window", () => {
    // The command already finished successfully (code 0) when a kill request
    // arrives. Success must win — otherwise a done run is mislabeled killed.
    expect(workflowOutcome({ killed: true, code: 0 })).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// runWorkflow: kill must escalate SIGTERM -> SIGKILL so a child that ignores
// SIGTERM can't hang the runner; and a child that never reads stdin must not
// surface an unhandled EPIPE.
// ---------------------------------------------------------------------------
describe("runWorkflow kill + stdin robustness", () => {
  it("force-kills a child that traps/ignores SIGTERM (SIGKILL escalation)", async () => {
    const ac = new AbortController();
    const p = runWorkflow("trap '' TERM; sleep 5; exit 0", "{}", process.cwd(), {
      signal: ac.signal,
      killGraceMs: 200,
    });
    // Give bash time to install the trap, then abort. With only SIGTERM the
    // child would ignore it and run the full sleep (exit 0); with escalation
    // it is SIGKILLed (code null) shortly after the grace period.
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const res = await p;
    expect(res.code).toBeNull();
  }, 10_000);

  it("resolves cleanly when the command never reads stdin (no unhandled EPIPE)", async () => {
    const bigPayload = JSON.stringify({ blob: "x".repeat(500_000) });
    const res = await runWorkflow("true", bigPayload, process.cwd(), {});
    expect(res.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processNextWorkflow: the runner orchestration. Real bash child + mocked
// Harbour HTTP. Asserts the exit-code -> status state machine and kill path.
// ---------------------------------------------------------------------------
describe("processNextWorkflow orchestration", () => {
  const runner = { apiKey: "k", name: "t", url: "http://h" };
  let statusPuts: string[];
  let activityPosts: { content?: string }[];
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "hb-wf-"));
    process.env.HARBOUR_HOME = home;
  });
  afterAll(() => {
    delete process.env.HARBOUR_HOME;
  });
  afterEach(() => vi.unstubAllGlobals());

  function res(obj: unknown) {
    return { ok: true, json: async () => obj } as unknown as Response;
  }

  // Install a fetch mock that serves one /next payload and records mutations.
  function install(payload: unknown, opts: { killRequested?: boolean } = {}) {
    statusPuts = [];
    activityPosts = [];
    let currentStatus = "running";
    const fetchMock = async (u: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method || "GET";
      if (u.endsWith("/api/workflows/next")) return res(payload);
      if (/\/kill$/.test(u)) return res({ kill_requested: !!opts.killRequested, status: currentStatus });
      if (/\/status$/.test(u) && method === "GET") return res({ status: currentStatus });
      if (/\/status$/.test(u) && method === "PUT") {
        const b = JSON.parse(init.body || "{}");
        currentStatus = b.status;
        statusPuts.push(b.status);
        return res({ ok: true });
      }
      if (/\/activity$/.test(u)) {
        activityPosts.push(JSON.parse(init.body || "{}"));
        return res({ ok: true });
      }
      return res({});
    };
    vi.stubGlobal("fetch", fetchMock);
  }

  const payloadFor = (command: string) => ({
    run: { id: "wf1" },
    job: { name: "t", command, timeout_minutes: 1 },
  });

  it("exit 0 -> done", async () => {
    install(payloadFor("echo hi"));
    const r = await processNextWorkflow(runner);
    expect(r.outcome).toBe("done");
    expect(statusPuts.at(-1)).toBe("done");
  });

  it("exit 77 -> skipped", async () => {
    install(payloadFor("exit 77"));
    const r = await processNextWorkflow(runner);
    expect(r.outcome).toBe("skipped");
    expect(statusPuts.at(-1)).toBe("skipped");
  });

  it("other non-zero -> failed", async () => {
    install(payloadFor("exit 3"));
    const r = await processNextWorkflow(runner);
    expect(r.outcome).toBe("failed");
    expect(statusPuts.at(-1)).toBe("failed");
  });

  it("missing command -> failed without spawning", async () => {
    install({ run: { id: "wf1" }, job: { name: "t", timeout_minutes: 1 } });
    const r = await processNextWorkflow(runner);
    expect(r.outcome).toBe("failed");
    expect(statusPuts).toEqual(["failed"]);
  });

  it("no payload -> no-work, no status written", async () => {
    install(null);
    const r = await processNextWorkflow(runner);
    expect(r.outcome).toBe("no-work");
    expect(statusPuts).toEqual([]);
  });

  it("posts stdout as a final activity entry on success", async () => {
    install(payloadFor("echo synced 3 rows"));
    await processNextWorkflow(runner);
    expect(activityPosts.some((a) => /synced 3 rows/.test(a.content || ""))).toBe(true);
  });

  it("kill during a running command -> killed (never leaves the run running)", async () => {
    install(payloadFor("sleep 3"), { killRequested: true });
    const r = await processNextWorkflow(runner, { killPollIntervalMs: 50 });
    expect(r.outcome).toBe("killed");
    expect(statusPuts.at(-1)).toBe("killed");
  }, 10_000);

  it("a kill landing as a clean command still exits 0 does NOT clobber success", async () => {
    // The command traps SIGTERM and exits 0 well before the SIGKILL grace, so
    // wfResult.code === 0 while the kill flag is set — success must win.
    install(payloadFor("trap '' TERM; sleep 0.4; exit 0"), { killRequested: true });
    const r = await processNextWorkflow(runner, { killPollIntervalMs: 50 });
    expect(statusPuts.at(-1)).toBe("done");
    expect(r.outcome).toBe("done");
  }, 10_000);
});
