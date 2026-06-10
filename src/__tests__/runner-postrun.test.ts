import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  postrunKillStatus,
  postrunStatusOverride,
  runPostrun,
  shouldRunPostrun,
} from "../../bin/lib/runner.mjs";

// ===========================================================================
// Postrun gate (#29) — pure decision helpers.
//
// Two independent decisions, mirroring the runner's seam:
//   1. shouldRunPostrun  — given the job's postrun config + the run's terminal
//                          outcome + whether the agent actually ran, decide
//                          whether to invoke the postrun command at all.
//   2. postrunStatusOverride — given the postrun command's exit code, decide
//                          whether the gate overrides the run's status (only
//                          enforcing mode, only done -> failed on nonzero).
//
// Modes:
//   gates OFF (informational, default): runs on ANY terminal outcome where the
//     agent ran (done/failed/killed/skipped); NEVER changes status.
//   gates ON (enforcing): runs after `done` only; nonzero exit overrides
//     done -> failed.
// ===========================================================================

const TERMINAL = ["done", "failed", "killed", "skipped"];

describe("shouldRunPostrun", () => {
  it("never runs without a postrun command (zero tax)", () => {
    for (const gates of [false, true]) {
      for (const outcome of TERMINAL) {
        expect(shouldRunPostrun({ command: null, outcome, gates, agentRan: true })).toBe(false);
        expect(shouldRunPostrun({ command: "", outcome, gates, agentRan: true })).toBe(false);
        expect(shouldRunPostrun({ command: undefined, outcome, gates, agentRan: true })).toBe(
          false,
        );
      }
    }
  });

  it("never runs when the agent turn did not execute (pure prerun-skip etc.)", () => {
    for (const gates of [false, true]) {
      for (const outcome of TERMINAL) {
        expect(shouldRunPostrun({ command: "cleanup.sh", outcome, gates, agentRan: false })).toBe(
          false,
        );
      }
    }
  });

  describe("informational mode (gates off)", () => {
    it("runs on ANY terminal outcome where the agent ran", () => {
      for (const outcome of TERMINAL) {
        expect(
          shouldRunPostrun({ command: "cleanup.sh", outcome, gates: false, agentRan: true }),
        ).toBe(true);
      }
    });

    it("does NOT run on non-terminal / mid-run statuses", () => {
      for (const outcome of ["running", "waiting", "pending", "scheduled"]) {
        expect(
          shouldRunPostrun({ command: "cleanup.sh", outcome, gates: false, agentRan: true }),
        ).toBe(false);
      }
    });
  });

  describe("enforcing mode (gates on)", () => {
    it("runs after `done` only", () => {
      expect(
        shouldRunPostrun({ command: "verify.sh", outcome: "done", gates: true, agentRan: true }),
      ).toBe(true);
    });

    it("does NOT run on any non-done terminal outcome", () => {
      for (const outcome of ["failed", "killed", "skipped"]) {
        expect(
          shouldRunPostrun({ command: "verify.sh", outcome, gates: true, agentRan: true }),
        ).toBe(false);
      }
    });

    it("does NOT run on non-terminal statuses", () => {
      for (const outcome of ["running", "waiting", "pending"]) {
        expect(
          shouldRunPostrun({ command: "verify.sh", outcome, gates: true, agentRan: true }),
        ).toBe(false);
      }
    });
  });
});

describe("postrunStatusOverride", () => {
  describe("informational mode (gates off)", () => {
    it("never overrides status, regardless of exit code", () => {
      for (const code of [0, 1, 77, 2, 137]) {
        expect(postrunStatusOverride({ gates: false, code, outcome: "done" })).toEqual({
          status: null,
        });
        expect(postrunStatusOverride({ gates: false, code, outcome: "failed" })).toEqual({
          status: null,
        });
      }
    });
  });

  describe("enforcing mode (gates on)", () => {
    it("leaves a passing gate (exit 0) as done", () => {
      expect(postrunStatusOverride({ gates: true, code: 0, outcome: "done" })).toEqual({
        status: null,
      });
    });

    it("overrides done -> failed on any nonzero exit", () => {
      for (const code of [1, 2, 77, 143]) {
        expect(postrunStatusOverride({ gates: true, code, outcome: "done" })).toEqual({
          status: "failed",
        });
      }
    });

    it("does not override a non-done outcome (enforcing only runs after done anyway)", () => {
      // Defensive: even if called with a non-done outcome, the override is scoped
      // to the done -> failed edge the transition guard permits.
      expect(postrunStatusOverride({ gates: true, code: 1, outcome: "failed" })).toEqual({
        status: null,
      });
      expect(postrunStatusOverride({ gates: true, code: 1, outcome: "skipped" })).toEqual({
        status: null,
      });
    });
  });
});

// ===========================================================================
// postrunKillStatus (#30) — a kill that lands DURING postrun.
//
// Postrun runs AFTER the run reaches a terminal status (done/failed/skipped/
// killed). By that point the run is finished; only postrun cleanup is still
// executing. A kill request mid-postrun therefore CANNOT re-finalize an
// already-terminal run — done -> killed / failed -> killed / skipped -> killed
// are all illegal under LEGAL_RUN_TRANSITIONS. So the decision is: never issue
// a status PUT; honor the existing terminal outcome. Pure, so the runner's seam
// is testable apart from the shell/HTTP plumbing.
// ===========================================================================

describe("postrunKillStatus", () => {
  it("never re-finalizes an already-terminal run (no status PUT)", () => {
    for (const outcome of TERMINAL) {
      expect(postrunKillStatus({ outcome })).toEqual({ status: null });
    }
  });
});

// ===========================================================================
// runPostrun (#30) — integration: a kill during postrun must NOT attempt an
// illegal terminal -> killed transition, and the outcome the runner reports
// MUST match the status actually written to the DB.
//
// Real bash child (a slow cleanup script) + a fetch mock that enforces the
// SAME transition guard the real status route does (LEGAL_RUN_TRANSITIONS),
// returning 409 on an illegal PUT exactly like updateRunStatus -> the route.
// ===========================================================================

describe("runPostrun — kill during postrun (integration)", () => {
  const LEGAL: Record<string, readonly string[]> = {
    scheduled: ["running"],
    running: ["waiting", "done", "failed", "skipped", "killed"],
    waiting: ["pending"],
    pending: ["running"],
    failed: ["pending"],
    skipped: ["pending"],
    killed: ["pending"],
    done: ["pending", "failed"],
  };

  const runner = { apiKey: "k", name: "t", url: "http://h", runId: "r1", agentName: "t" };
  let statusPuts: string[];
  let illegalPuts: { from: string; to: string }[];
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "hb-postrun-"));
    process.env.HARBOUR_HOME = home;
  });
  afterAll(() => {
    delete process.env.HARBOUR_HOME;
  });
  afterEach(() => vi.unstubAllGlobals());

  function res(obj: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => obj } as unknown as Response;
  }

  // Fetch mock backed by a single mutable status that enforces the transition
  // guard. An illegal PUT is recorded and rejected with a 409 (apiCall throws),
  // mirroring the real status route — so the test fails loudly if runPostrun
  // ever attempts terminal -> killed.
  function install(initialStatus: string, opts: { killRequested?: boolean } = {}) {
    statusPuts = [];
    illegalPuts = [];
    let currentStatus = initialStatus;
    const fetchMock = async (u: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method || "GET";
      if (/\/kill$/.test(u))
        return res({ kill_requested: !!opts.killRequested, status: currentStatus });
      if (/\/status$/.test(u) && method === "GET") return res({ status: currentStatus });
      if (/\/status$/.test(u) && method === "PUT") {
        const to = JSON.parse(init.body || "{}").status as string;
        if (to === currentStatus) return res({ ok: true }); // idempotent no-op
        const allowed = LEGAL[currentStatus] ?? [];
        if (!allowed.includes(to)) {
          illegalPuts.push({ from: currentStatus, to });
          return res({ error: "Illegal run status transition" }, false, 409);
        }
        currentStatus = to;
        statusPuts.push(to);
        return res({ ok: true });
      }
      if (/\/activity$/.test(u)) return res({ ok: true });
      return res({});
    };
    vi.stubGlobal("fetch", fetchMock);
    return () => currentStatus;
  }

  // Informational postrun (gates off) fires on every terminal outcome. A kill
  // during it must honor the existing outcome — NOT attempt terminal -> killed.
  for (const outcome of ["done", "failed", "skipped"]) {
    it(`honors '${outcome}' when a kill lands mid-postrun (no illegal terminal -> killed)`, async () => {
      const readStatus = install(outcome, { killRequested: true });
      const resolved = await runPostrun({
        job: { postrun: "sleep 1", postrun_gates: false },
        outcome,
        agentRan: true,
        ...runner,
        env: {},
        payloadJson: "{}",
        killPollIntervalMs: 50,
      });
      // Runner reports the existing terminal outcome...
      expect(resolved).toBe(outcome);
      // ...and the DB status the runner left matches it.
      expect(readStatus()).toBe(outcome);
      // Crucially: no illegal terminal -> killed PUT was attempted.
      expect(illegalPuts).toEqual([]);
    }, 10_000);
  }

  it("treats a kill during a postrun on an already-killed run as an idempotent no-op", async () => {
    const readStatus = install("killed", { killRequested: true });
    const resolved = await runPostrun({
      job: { postrun: "sleep 1", postrun_gates: false },
      outcome: "killed",
      agentRan: true,
      ...runner,
      env: {},
      payloadJson: "{}",
      killPollIntervalMs: 50,
    });
    expect(resolved).toBe("killed");
    expect(readStatus()).toBe("killed");
    expect(illegalPuts).toEqual([]);
  }, 10_000);
});
