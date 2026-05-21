import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildPlist, inspectRunnerInstall, repairRunnerInstall } from "../../bin/lib/install.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-runner-install-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runner LaunchAgent install repair", () => {
  it("detects a stale Documents/OpenCode runner path", () => {
    const dir = makeTempDir();
    const plistPath = path.join(dir, "com.harbour.agent-runner.plist");
    const expected = path.join(dir, "current", "harbour", "bin", "harbour.mjs");
    const stale = "/Users/davidk/Documents/OpenCode/harbour/bin/harbour.mjs";
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, "");
    fs.writeFileSync(plistPath, buildPlist({ harbourBin: stale, nodePath: process.execPath }));

    const status = inspectRunnerInstall({ plistPath, harbourBin: expected, checkLoaded: false });

    expect(status.healthy).toBe(false);
    expect(status.runnerPath).toBe(stale);
    expect(status.issues).toContain("stale-harbour-path");
    expect(status.issues).toContain("wrong-harbour-path");
    expect(status.issues).toContain("missing-runner-target");
  });

  it("rewrites a stale plist to the current Harbour runner and snapshots the old one", () => {
    const dir = makeTempDir();
    const plistPath = path.join(dir, "com.harbour.agent-runner.plist");
    const expected = path.join(dir, "current", "harbour", "bin", "harbour.mjs");
    const stale = "/Users/davidk/Documents/OpenCode/harbour/bin/harbour.mjs";
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, "");
    fs.writeFileSync(plistPath, buildPlist({ harbourBin: stale, nodePath: process.execPath }));

    const result = repairRunnerInstall({
      plistPath,
      harbourBin: expected,
      nodePath: process.execPath,
      reload: false,
    });

    expect(result.snapshotPath).toBeTruthy();
    expect(fs.existsSync(result.snapshotPath!)).toBe(true);
    expect(result.status.runnerPath).toBe(expected);
    expect(result.status.issues).not.toContain("stale-harbour-path");
    expect(result.status.issues).not.toContain("wrong-harbour-path");
  });
});
