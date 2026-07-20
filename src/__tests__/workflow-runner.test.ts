import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  processNextWorkflow,
  runPool,
  runWorkflow,
  workflowOutcome,
} from "../../bin/lib/runner.mjs";

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
    const p = runWorkflow(["bash", "-c", "trap '' TERM; sleep 5; exit 0"], "{}", process.cwd(), {
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
    const res = await runWorkflow(["bash", "-c", "true"], bigPayload, process.cwd(), {});
    expect(res.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processNextWorkflow: the runner orchestration. Real bash child + mocked
// Harbour HTTP. Asserts the exit-code -> status state machine and kill path.
// ---------------------------------------------------------------------------
describe("processNextWorkflow orchestration", () => {
  // The pool claims a workflow run and dispatches it here with its exec token.
  const creds = { url: "http://h", execToken: "hbx_test" };
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

  // Mock the run-lifecycle endpoints (kill/status/activity) the executor calls.
  function install(opts: { killRequested?: boolean } = {}) {
    statusPuts = [];
    activityPosts = [];
    let currentStatus = "running";
    const fetchMock = async (u: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method || "GET";
      if (/\/kill$/.test(u))
        return res({ kill_requested: !!opts.killRequested, status: currentStatus });
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

  const payloadFor = (content: string) => ({
    run: { id: "wf1" },
    exec_token: "hbx_test",
    job: {
      kind: "workflow",
      name: "t",
      command: { runtime: "bash", content },
      scripts_dir: "proj/job",
      timeout_minutes: 1,
    },
  });

  it("exit 0 -> done", async () => {
    install();
    const r = await processNextWorkflow(payloadFor("echo hi"), creds);
    expect(r.outcome).toBe("done");
    expect(statusPuts.at(-1)).toBe("done");
  });

  it("exit 77 -> skipped", async () => {
    install();
    const r = await processNextWorkflow(payloadFor("exit 77"), creds);
    expect(r.outcome).toBe("skipped");
    expect(statusPuts.at(-1)).toBe("skipped");
  });

  it("other non-zero -> failed", async () => {
    install();
    const r = await processNextWorkflow(payloadFor("exit 3"), creds);
    expect(r.outcome).toBe("failed");
    expect(statusPuts.at(-1)).toBe("failed");
  });

  it("missing command -> failed without spawning", async () => {
    install();
    const r = await processNextWorkflow(
      {
        run: { id: "wf1" },
        exec_token: "hbx_test",
        job: { kind: "workflow", name: "t", timeout_minutes: 1 },
      },
      creds,
    );
    expect(r.outcome).toBe("failed");
    expect(statusPuts).toEqual(["failed"]);
  });

  it("posts stdout as a final activity entry on success", async () => {
    install();
    await processNextWorkflow(payloadFor("echo synced 3 rows"), creds);
    expect(activityPosts.some((a) => /synced 3 rows/.test(a.content || ""))).toBe(true);
  });

  it("kill during a running command -> killed (never leaves the run running)", async () => {
    install({ killRequested: true });
    const r = await processNextWorkflow(payloadFor("sleep 3"), creds, { killPollIntervalMs: 50 });
    expect(r.outcome).toBe("killed");
    expect(statusPuts.at(-1)).toBe("killed");
  }, 10_000);

  it("a kill landing as a clean command still exits 0 does NOT clobber success", async () => {
    // The command traps SIGTERM and exits 0 well before the SIGKILL grace, so
    // wfResult.code === 0 while the kill flag is set — success must win.
    install({ killRequested: true });
    const r = await processNextWorkflow(payloadFor("trap '' TERM; sleep 0.4; exit 0"), creds, {
      killPollIntervalMs: 50,
    });
    expect(statusPuts.at(-1)).toBe("done");
    expect(r.outcome).toBe("done");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// runPool: the unified claim->dispatch->drain loop. Mocks /api/runner/claim to
// hand out one workflow then nothing; asserts it claims with capabilities + the
// runner token, dispatches by job.kind, runs the gate, and drains to exit.
// ---------------------------------------------------------------------------
describe("runPool (claim → dispatch → drain)", () => {
  let home: string;
  let claimCalls: { auth?: string; body: { capabilities?: unknown } }[];
  let statusPuts: string[];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "hb-pool-"));
    process.env.HARBOUR_HOME = home;
    process.env.HARBOUR_URL = "http://pool-host";
    writeFileSync(join(home, "runner.token"), "hbrn_pooltoken\n");
  });
  afterAll(() => {
    delete process.env.HARBOUR_HOME;
    delete process.env.HARBOUR_URL;
  });
  afterEach(() => vi.unstubAllGlobals());

  function res(obj: unknown) {
    return { ok: true, json: async () => obj } as unknown as Response;
  }

  it("claims a workflow, runs its gate, then drains when no work remains", async () => {
    claimCalls = [];
    statusPuts = [];
    let currentStatus = "running";
    let served = false;
    const payload = {
      run: { id: "wfp" },
      exec_token: "hbx_pool",
      job: {
        kind: "workflow",
        name: "p",
        command: { runtime: "bash", content: "echo pooled" },
        scripts_dir: "proj/poolwf",
        timeout_minutes: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      async (
        u: string,
        init: { method?: string; body?: string; headers?: Record<string, string> } = {},
      ) => {
        const method = init.method || "GET";
        const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
        if (/\/api\/runner\/claim$/.test(u)) {
          claimCalls.push({ auth, body: JSON.parse(init.body || "{}") });
          if (!served) {
            served = true;
            return res(payload); // first claim → the workflow
          }
          return res({ run: null }); // subsequent claims → drained
        }
        if (/\/kill$/.test(u)) return res({ kill_requested: false, status: currentStatus });
        if (/\/status$/.test(u) && method === "PUT") {
          currentStatus = JSON.parse(init.body || "{}").status;
          statusPuts.push(currentStatus);
        }
        return res({ ok: true });
      },
    );

    await runPool();

    // It claimed against the configured URL with the runner token + capabilities,
    // then claimed again until drained.
    expect(claimCalls.length).toBeGreaterThanOrEqual(2);
    expect(claimCalls[0].auth).toBe("Bearer hbrn_pooltoken");
    expect(claimCalls[0].body.capabilities).toBeTruthy();
    // The workflow gate ran and the run was finalized done.
    expect(statusPuts.at(-1)).toBe("done");
  }, 15_000);

  it("a transient claim error does not masquerade as no-work (logs distinctly, runs nothing)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    vi.stubGlobal("fetch", async (u: string) => {
      if (/\/api\/runner\/claim$/.test(u)) throw new Error("ECONNREFUSED");
      return res({ ok: true });
    });
    try {
      await runPool(); // must not throw, must not say "Nothing to do."
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => /Claim error/.test(l))).toBe(true);
    expect(logs.some((l) => /Nothing to do/.test(l))).toBe(false);
  });

  it("does nothing (and never dispatches) when no runner token is present", async () => {
    delete process.env.HARBOUR_HOME;
    const empty = mkdtempSync(join(tmpdir(), "hb-empty-"));
    process.env.HARBOUR_HOME = empty; // no runner.token here
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(u);
      return res({ run: null });
    });
    await runPool();
    expect(calls).toEqual([]); // never even tried to claim
    process.env.HARBOUR_HOME = home; // restore for afterAll
  });
});
