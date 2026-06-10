import { describe, expect, it } from "vitest";
import { runWorkflow } from "../../bin/lib/runner.mjs";

// The sending half of workflow live-progress updates: the runner must hand the
// script its run credentials in the environment so it can post breadcrumbs to
// POST /api/runs/:id/activity while it runs. These tests verify runWorkflow
// actually exposes extraEnv to the child's shell.
describe("runWorkflow env injection", () => {
  it("exposes HARBOUR_* run credentials to the script's shell", async () => {
    const res = await runWorkflow(
      'echo "$HARBOUR_URL|$HARBOUR_RUN_ID|$HARBOUR_API_KEY"',
      "{}",
      process.cwd(),
      {
        extraEnv: {
          HARBOUR_RUN_ID: "run_123",
          HARBOUR_API_KEY: "key_abc",
          HARBOUR_URL: "http://h",
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("http://h|run_123|key_abc");
  });

  it("layers job-linked env vars in too, so scripts can expand $SECRET", async () => {
    const res = await runWorkflow('echo "$EXTERNAL_API_TOKEN"', "{}", process.cwd(), {
      extraEnv: { EXTERNAL_API_TOKEN: "s3cret" },
    });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("s3cret");
  });

  it("still pipes the payload JSON to stdin alongside the injected env", async () => {
    const payload = JSON.stringify({ run: { id: "run_123" } });
    const res = await runWorkflow("cat", payload, process.cwd(), {
      extraEnv: { HARBOUR_RUN_ID: "run_123" },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).run.id).toBe("run_123");
  });

  it("propagates a non-zero exit code (e.g. 77 skip) unchanged", async () => {
    const res = await runWorkflow("exit 77", "{}", process.cwd(), { extraEnv: {} });
    expect(res.code).toBe(77);
  });
});
