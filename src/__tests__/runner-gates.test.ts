import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeGate, resolveJobDir } from "../../bin/lib/runner.mjs";

// ===========================================================================
// Job gates (runner side). A gate is { runtime, content } and its body lives in
// SQLite, riding the /next run payload's job block. Right before a gate runs the
// runner resolves a per-job dir under `$HARBOUR_HOME/workflows/<scripts_dir>`
// and materializes the gate's body there as `<role>.<ext>`, so the spawned
// interpreter has a file to run. scripts_dir is a server-computed relative path;
// a job without one can't run a gate at all (no flat-dir fallback anymore).
//
// resolveJobDir is pure; materializeGate is the one I/O helper. Both are
// exercised here apart from the spawn/kill/timeout plumbing.
// ===========================================================================

describe("resolveJobDir", () => {
  it("joins harbourHome/workflows/scriptsDir", () => {
    const cwd = resolveJobDir({
      harbourHome: "/home/h/.harbour",
      scriptsDir: "acme/web/checker/health-check-1a2b3c4d",
    });
    expect(cwd).toBe("/home/h/.harbour/workflows/acme/web/checker/health-check-1a2b3c4d");
  });

  it("throws when scriptsDir is null, undefined, or empty", () => {
    // A malformed/unknown job yields scripts_dir=null server-side; the runner
    // must refuse rather than invent a path — there is no flat-dir fallback.
    expect(() => resolveJobDir({ harbourHome: "/home/h/.harbour", scriptsDir: null })).toThrow();
    expect(() =>
      resolveJobDir({ harbourHome: "/home/h/.harbour", scriptsDir: undefined }),
    ).toThrow();
    expect(() => resolveJobDir({ harbourHome: "/home/h/.harbour", scriptsDir: "" })).toThrow();
  });

  it("defaults harbourHome from HARBOUR_HOME", () => {
    const prev = process.env.HARBOUR_HOME;
    process.env.HARBOUR_HOME = "/tmp/hb-home";
    try {
      expect(resolveJobDir({ scriptsDir: "org/leaf" })).toBe("/tmp/hb-home/workflows/org/leaf");
    } finally {
      if (prev === undefined) delete process.env.HARBOUR_HOME;
      else process.env.HARBOUR_HOME = prev;
    }
  });
});

describe("materializeGate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-gates-"));
  });
  afterEach(() => {
    // mkdtemp dirs are throwaway; leave cleanup to the OS tmp reaper.
  });

  it("writes a bash prerun as prerun.sh run via bash", () => {
    const cwd = join(dir, "bash");
    const result = materializeGate(cwd, { runtime: "bash", content: "echo hi\n" }, "prerun");

    expect(result).toEqual({ binary: "bash", args: ["prerun.sh"], file: "prerun.sh" });
    const path = join(cwd, "prerun.sh");
    expect(readFileSync(path, "utf8")).toBe("echo hi\n");
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("writes a python prerun as prerun.py run via python3", () => {
    const cwd = join(dir, "python");
    const result = materializeGate(cwd, { runtime: "python", content: "print('hi')\n" }, "prerun");

    expect(result).toEqual({ binary: "python3", args: ["prerun.py"], file: "prerun.py" });
    const path = join(cwd, "prerun.py");
    expect(readFileSync(path, "utf8")).toBe("print('hi')\n");
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("writes a node workflow as workflow.js run via node", () => {
    const cwd = join(dir, "node");
    const result = materializeGate(
      cwd,
      { runtime: "node", content: "console.log('hi')\n" },
      "workflow",
    );

    expect(result).toEqual({ binary: "node", args: ["workflow.js"], file: "workflow.js" });
    const path = join(cwd, "workflow.js");
    expect(readFileSync(path, "utf8")).toBe("console.log('hi')\n");
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("mkdir -p's a nested cwd before writing", () => {
    const cwd = join(dir, "deep", "nested", "job-leaf");
    materializeGate(cwd, { runtime: "bash", content: "x" }, "postrun");
    expect(readFileSync(join(cwd, "postrun.sh"), "utf8")).toBe("x");
    expect(statSync(cwd).isDirectory()).toBe(true);
  });

  it("falls back to bash for an unknown runtime", () => {
    const cwd = join(dir, "unknown");
    const result = materializeGate(cwd, { runtime: "ruby", content: "puts 1" }, "prerun");

    expect(result).toEqual({ binary: "bash", args: ["prerun.sh"], file: "prerun.sh" });
    expect(readFileSync(join(cwd, "prerun.sh"), "utf8")).toBe("puts 1");
  });

  it("defaults missing content to an empty file", () => {
    const cwd = join(dir, "empty");
    materializeGate(cwd, { runtime: "bash", content: undefined as unknown as string }, "prerun");
    expect(readFileSync(join(cwd, "prerun.sh"), "utf8")).toBe("");
  });
});
