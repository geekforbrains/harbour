import { describe, expect, it } from "vitest";
import { getProvider } from "../../bin/lib/providers.mjs";
import {
  buildApiPrompt,
  buildFinalizePrompt,
  buildPrompt,
  FINALIZE_MAX_ATTEMPTS,
  finalizeStep,
  isTerminalStatus,
  resolveFinalizeMode,
  resolveKillOutcome,
  shouldRunFinalize,
  TERMINAL_STATUSES,
} from "../../bin/lib/runner.mjs";

// A minimal API descriptor matching the shape /next sends in payload.api.
// buildApiPrompt / buildFinalizePrompt read `.endpoints.<name>` and strip the
// HTTP verb prefix.
const API = {
  endpoints: {
    set_title: "PUT https://h.test/api/runs/r1/title",
    update_status: "PUT https://h.test/api/runs/r1/status",
    post_activity: "POST https://h.test/api/runs/r1/activity",
    upload_attachment: "POST https://h.test/api/runs/r1/attachments",
    guide: "GET https://h.test/api/guide",
  },
};
const API_KEY = "sk-test-123";

const MANDATE = "You MUST set a final run status";

// ===========================================================================
// Work prompt: the status MANDATE is gone, the status-endpoint docs + title
// preamble stay. (Setting `waiting` mid-run is still a legitimate agent action.)
// ===========================================================================

describe("buildApiPrompt (work prompt)", () => {
  const prompt = buildApiPrompt(API, API_KEY);

  it("no longer mandates a final status", () => {
    expect(prompt).not.toContain(MANDATE);
    expect(prompt).not.toContain("it will be marked as failed");
    expect(prompt).not.toContain("the run will be marked as failed");
  });

  it("keeps the title-setting preamble", () => {
    expect(prompt).toContain("set a short title for this run");
    expect(prompt).toContain("https://h.test/api/runs/r1/title");
  });

  it("keeps the status-endpoint curl docs (agent can set waiting mid-run)", () => {
    expect(prompt).toContain("https://h.test/api/runs/r1/status");
    expect(prompt).toContain('"status":"waiting"');
  });

  it("keeps the API key and guide url", () => {
    expect(prompt).toContain(API_KEY);
    expect(prompt).toContain("https://h.test/api/guide");
  });
});

// ===========================================================================
// Work prompt: linked tables must be surfaced so the agent can learn their ids.
// The claim payload carries `tables` (keyed by name, id only), so the prompt is
// the agent's cheapest source of table ids. Regression guard for the dropped
// `## Tables` block.
// ===========================================================================

describe("buildPrompt (work prompt) — tables block", () => {
  const base = {
    run: { id: "r1", status: "running", title: null, activity: [] },
    job: { name: "Demo", instructions: "do the thing" },
    api: API,
  };

  it("renders a ## Tables section with each linked table's name and id", () => {
    const prompt = buildPrompt(
      { ...base, tables: { ad_plans: { id: "tbl-abc" }, support_state: { id: "tbl-def" } } },
      API_KEY,
      false,
    );
    expect(prompt).toContain("## Tables");
    expect(prompt).toContain("`ad_plans`");
    expect(prompt).toContain("tbl-abc");
    expect(prompt).toContain("`support_state`");
    expect(prompt).toContain("tbl-def");
  });

  it("omits the Tables section when the run has no linked tables", () => {
    expect(buildPrompt({ ...base, tables: {} }, API_KEY, false)).not.toContain("## Tables");
    expect(buildPrompt(base, API_KEY, false)).not.toContain("## Tables");
  });
});

// ===========================================================================
// Finalize prompt: tight, carries the mandate, single tool call, "do nothing
// else". Fresh-fallback variant carries the activity log as context.
// ===========================================================================

describe("buildFinalizePrompt", () => {
  it("contains the explicit set-status mandate and the valid set", () => {
    const p = buildFinalizePrompt(API, API_KEY, { mode: "resume" });
    expect(p).toContain("set the run status");
    for (const s of ["done", "waiting", "failed", "skipped"]) {
      expect(p).toContain(s);
    }
  });

  it("includes the status endpoint curl with the api key", () => {
    const p = buildFinalizePrompt(API, API_KEY, { mode: "resume" });
    expect(p).toContain("https://h.test/api/runs/r1/status");
    expect(p).toContain(API_KEY);
  });

  it("instructs the agent to do nothing else", () => {
    const p = buildFinalizePrompt(API, API_KEY, { mode: "resume" });
    expect(p.toLowerCase()).toContain("do nothing else");
  });

  it("resume mode does NOT inline the work activity log (session has context)", () => {
    const p = buildFinalizePrompt(API, API_KEY, {
      mode: "resume",
      activityContext: "[agent] did a bunch of work",
    });
    expect(p).not.toContain("did a bunch of work");
  });

  it("fresh mode carries the activity log as context", () => {
    const p = buildFinalizePrompt(API, API_KEY, {
      mode: "fresh",
      activityContext: "[agent] did a bunch of work",
    });
    expect(p).toContain("did a bunch of work");
  });

  it("the work prompt and finalize prompt are clearly different", () => {
    const work = buildApiPrompt(API, API_KEY);
    const fin = buildFinalizePrompt(API, API_KEY, { mode: "resume" });
    expect(fin).not.toBe(work);
    // The mandate lives ONLY in the finalize prompt now.
    expect(work).not.toContain(MANDATE);
  });
});

// ===========================================================================
// Terminal-status detection
// ===========================================================================

describe("isTerminalStatus", () => {
  it("treats the valid finish set as terminal", () => {
    for (const s of ["done", "waiting", "failed", "skipped"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("does NOT treat in-flight / non-finish statuses as terminal", () => {
    for (const s of ["running", "scheduled", "pending", "killed", "", undefined, null]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it("exposes the canonical terminal set", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["done", "failed", "skipped", "waiting"]);
  });
});

describe("shouldRunFinalize", () => {
  it("skips finalize when the agent already set a terminal status", () => {
    for (const s of ["done", "waiting", "failed", "skipped"]) {
      expect(shouldRunFinalize(s)).toBe(false);
    }
  });

  it("runs finalize when status is still non-terminal", () => {
    for (const s of ["running", "pending", "scheduled", ""]) {
      expect(shouldRunFinalize(s)).toBe(true);
    }
  });
});

// ===========================================================================
// Resume-capability resolver: resume the same session when possible, else fall
// back to a fresh finalize turn. Same provider always (resume is provider-bound).
// ===========================================================================

describe("resolveFinalizeMode", () => {
  it("resumes when the provider supports resume and a session id exists", () => {
    const claude = getProvider("claude");
    expect(resolveFinalizeMode(claude, "sess-1").mode).toBe("resume");
  });

  it("falls back to fresh when there is no session id", () => {
    const claude = getProvider("claude");
    expect(resolveFinalizeMode(claude, null).mode).toBe("fresh");
    expect(resolveFinalizeMode(claude, "").mode).toBe("fresh");
  });

  it("falls back to fresh when the provider cannot resume", () => {
    const noResume = { canResume: false, buildCommand() {} };
    expect(resolveFinalizeMode(noResume, "sess-1").mode).toBe("fresh");
  });

  it("all shipped providers advertise resume capability", () => {
    for (const cli of ["claude", "codex"]) {
      expect(getProvider(cli).canResume).toBe(true);
    }
  });
});

// ===========================================================================
// Finalize loop step / exhaustion reducer (pure). Each step takes the status
// re-checked after a finalize turn and the attempt count; it decides whether to
// stop (valid status reached) or continue, and on exhaustion forces 'failed'.
// ===========================================================================

describe("finalizeStep", () => {
  it("stops with the agent's status once it sets a terminal value", () => {
    const r = finalizeStep({ status: "done", attempt: 1 });
    expect(r.done).toBe(true);
    expect(r.outcome).toBe("done");
    expect(r.forced).toBe(false);
  });

  it("treats waiting as a valid finalize outcome (stops the loop)", () => {
    const r = finalizeStep({ status: "waiting", attempt: 1 });
    expect(r.done).toBe(true);
    expect(r.outcome).toBe("waiting");
  });

  it("continues while status is non-terminal and attempts remain", () => {
    const r = finalizeStep({ status: "running", attempt: 1 });
    expect(r.done).toBe(false);
  });

  it("forces failed on exhaustion (last attempt, still non-terminal)", () => {
    const r = finalizeStep({ status: "running", attempt: FINALIZE_MAX_ATTEMPTS });
    expect(r.done).toBe(true);
    expect(r.outcome).toBe("failed");
    expect(r.forced).toBe(true);
  });

  it("caps at exactly 3 attempts", () => {
    expect(FINALIZE_MAX_ATTEMPTS).toBe(3);
  });
});

describe("resolveKillOutcome", () => {
  // When a kill lands but the agent already reported a stable status, the kill
  // is moot — forcing 'killed' on top would be wrong and, for a terminal value,
  // an illegal transition (e.g. done -> killed). These statuses are respected.
  it("respects an already-reported terminal status (kill landed too late)", () => {
    expect(resolveKillOutcome("done")).toBe("done");
    expect(resolveKillOutcome("failed")).toBe("failed");
    expect(resolveKillOutcome("skipped")).toBe("skipped");
  });

  it("respects waiting (a valid parked state, not a kill)", () => {
    expect(resolveKillOutcome("waiting")).toBe("waiting");
  });

  it("returns 'killed' when the run was still running (a real kill)", () => {
    expect(resolveKillOutcome("running")).toBe("killed");
  });

  it("returns 'killed' when no status was read back", () => {
    expect(resolveKillOutcome(null)).toBe("killed");
    expect(resolveKillOutcome(undefined)).toBe("killed");
  });

  it("does not treat non-moot intermediate statuses as already-finished", () => {
    // pending/scheduled are mid-lifecycle, not a reported outcome — a kill wins.
    expect(resolveKillOutcome("pending")).toBe("killed");
    expect(resolveKillOutcome("scheduled")).toBe("killed");
  });
});
