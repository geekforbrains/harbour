import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildRunEnv, runPostrun } from "../../bin/lib/runner.mjs";

// docs/concepts/workflows.md promises all three gates (prerun, workflow,
// postrun) the same environment: job-linked vars as $NAME plus the
// HARBOUR_RUN_ID / HARBOUR_API_KEY / HARBOUR_URL run credentials. Prerun and
// the workflow command build that trio; postrun was passing only the job vars,
// so the documented `curl "$HARBOUR_URL/api/runs/$HARBOUR_RUN_ID/activity"`
// pattern expanded to empty strings in a postrun script.

describe("buildRunEnv", () => {
  it("layers job vars under the HARBOUR_* run credentials", () => {
    const env = buildRunEnv({
      env: { SECRET: "s3cret" },
      url: "http://h",
      runId: "run_1",
      execToken: "tok_1",
    });
    expect(env).toEqual({
      SECRET: "s3cret",
      HARBOUR_RUN_ID: "run_1",
      HARBOUR_API_KEY: "tok_1",
      HARBOUR_URL: "http://h",
    });
  });

  it("lets HARBOUR_* win over a colliding job var", () => {
    const env = buildRunEnv({
      env: { HARBOUR_URL: "http://evil" },
      url: "http://h",
      runId: "run_1",
      execToken: "tok_1",
    });
    expect(env.HARBOUR_URL).toBe("http://h");
  });
});

describe("postrun gate environment", () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "hb-gate-env-"));
    process.env.HARBOUR_HOME = home;
  });
  afterAll(() => {
    delete process.env.HARBOUR_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Run a postrun gate whose script dumps its environment to a file, and read
   * it back. Network calls (kill poll, activity post) are stubbed — this test
   * is about the child's env, not the callbacks.
   */
  async function postrunEnv(jobEnv: Record<string, string>): Promise<Record<string, string>> {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    const out = join(home, `env-${Math.random().toString(36).slice(2)}.txt`);
    const script = [
      `echo "HARBOUR_URL=$HARBOUR_URL" > "${out}"`,
      `echo "HARBOUR_RUN_ID=$HARBOUR_RUN_ID" >> "${out}"`,
      `echo "HARBOUR_API_KEY=$HARBOUR_API_KEY" >> "${out}"`,
      `echo "SECRET=$SECRET" >> "${out}"`,
    ].join("\n");

    await runPostrun({
      job: {
        postrun: { runtime: "bash", content: script },
        postrun_gates: false,
        scripts_dir: "gate-env-test",
      },
      outcome: "done",
      agentRan: true,
      url: "http://harbour.test",
      apiKey: "exec_tok",
      runId: "run_42",
      agentName: "tester",
      env: jobEnv,
      payloadJson: "{}",
      killPollIntervalMs: 60_000,
    });

    const parsed: Record<string, string> = {};
    for (const line of readFileSync(out, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    return parsed;
  }

  it("hands the postrun script the HARBOUR_* run credentials", async () => {
    const env = await postrunEnv({});
    expect(env.HARBOUR_URL).toBe("http://harbour.test");
    expect(env.HARBOUR_RUN_ID).toBe("run_42");
    expect(env.HARBOUR_API_KEY).toBe("exec_tok");
  });

  it("still exposes job-linked env vars as $NAME", async () => {
    const env = await postrunEnv({ SECRET: "s3cret" });
    expect(env.SECRET).toBe("s3cret");
    expect(env.HARBOUR_RUN_ID).toBe("run_42");
  });

  it("lets the HARBOUR_* credentials win over a colliding job var", async () => {
    const env = await postrunEnv({ HARBOUR_URL: "http://evil" });
    expect(env.HARBOUR_URL).toBe("http://harbour.test");
  });
});
