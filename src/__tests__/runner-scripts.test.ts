import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeScripts, resolveScriptsCwd } from "../../bin/lib/runner.mjs";

// ===========================================================================
// Per-job scripts (runner side). Script CONTENT lives in SQLite and rides the
// /next run payload's job block as `scripts: [{ filename, content, executable }]`
// + `scripts_dir` (a server-computed relative path). Right before a job's
// command runs the runner resolves a per-job cwd and materializes the files
// there, so a command like `./prerun.sh` finds the file. A job with no scripts
// keeps the legacy flat `$HARBOUR_HOME/workflows` cwd (backward compatible).
//
// resolveScriptsCwd is pure; materializeScripts is the one I/O helper. Both are
// exercised here apart from the kill/timeout/shell plumbing.
// ===========================================================================

describe("resolveScriptsCwd", () => {
  it("returns the per-job dir under workflows when scripts are present", () => {
    const cwd = resolveScriptsCwd({
      harbourHome: "/home/h/.harbour",
      scriptsDir: "acme/web/checker/health-check-1a2b3c4d",
      hasScripts: true,
    });
    expect(cwd).toBe("/home/h/.harbour/workflows/acme/web/checker/health-check-1a2b3c4d");
  });

  it("falls back to the legacy flat workflows dir when there are no scripts", () => {
    const cwd = resolveScriptsCwd({
      harbourHome: "/home/h/.harbour",
      scriptsDir: "acme/web/checker/health-check-1a2b3c4d",
      hasScripts: false,
    });
    expect(cwd).toBe("/home/h/.harbour/workflows");
  });

  it("falls back to the flat dir when scriptsDir is null even with scripts", () => {
    // A malformed/unknown job yields scripts_dir=null server-side; the runner
    // must not invent a path — it runs flat, exactly as it did before.
    const cwd = resolveScriptsCwd({
      harbourHome: "/home/h/.harbour",
      scriptsDir: null,
      hasScripts: true,
    });
    expect(cwd).toBe("/home/h/.harbour/workflows");
  });

  it("defaults harbourHome from HARBOUR_HOME", () => {
    const prev = process.env.HARBOUR_HOME;
    process.env.HARBOUR_HOME = "/tmp/hb-home";
    try {
      expect(resolveScriptsCwd({ scriptsDir: "org/leaf", hasScripts: true })).toBe(
        "/tmp/hb-home/workflows/org/leaf",
      );
      expect(resolveScriptsCwd({ scriptsDir: "org/leaf", hasScripts: false })).toBe(
        "/tmp/hb-home/workflows",
      );
    } finally {
      if (prev === undefined) delete process.env.HARBOUR_HOME;
      else process.env.HARBOUR_HOME = prev;
    }
  });
});

describe("materializeScripts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-scripts-"));
  });
  afterEach(() => {
    // mkdtemp dirs are throwaway; leave cleanup to the OS tmp reaper.
  });

  it("writes each script with the right content and mode bits", () => {
    const cwd = join(dir, "acme", "web", "checker", "health-check-1a2b3c4d");
    materializeScripts(cwd, [
      { filename: "prerun.sh", content: "#!/usr/bin/env bash\necho hi\n", executable: true },
      { filename: "config.json", content: '{"ok":true}', executable: false },
    ]);

    expect(readFileSync(join(cwd, "prerun.sh"), "utf8")).toBe("#!/usr/bin/env bash\necho hi\n");
    expect(readFileSync(join(cwd, "config.json"), "utf8")).toBe('{"ok":true}');

    // Low 9 mode bits: executable -> 0o700, data -> 0o600.
    expect(statSync(join(cwd, "prerun.sh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(cwd, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("creates the per-job directory (mkdir -p) before writing", () => {
    const cwd = join(dir, "deep", "nested", "job-leaf");
    materializeScripts(cwd, [{ filename: "a", content: "x", executable: false }]);
    expect(readFileSync(join(cwd, "a"), "utf8")).toBe("x");
  });

  it("is a no-op for an empty/missing script list (legacy flat-cwd jobs)", () => {
    const cwd = join(dir, "flat");
    // No throw; the dir is created but stays empty.
    materializeScripts(cwd, []);
    materializeScripts(cwd, undefined as unknown as []);
    expect(statSync(cwd).isDirectory()).toBe(true);
  });

  it("defaults missing content to an empty file", () => {
    const cwd = join(dir, "job");
    materializeScripts(cwd, [
      { filename: "empty.sh", content: undefined as unknown as string, executable: true },
    ]);
    expect(readFileSync(join(cwd, "empty.sh"), "utf8")).toBe("");
  });
});
