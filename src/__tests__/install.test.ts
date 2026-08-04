import type { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLaunchdPlist,
  installRunner,
  supportsRunnerService,
  uninstallRunner,
} from "../../bin/lib/install.mjs";

const tempDirs: string[] = [];

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-install-"));
  tempDirs.push(dir);
  return { target: path.join(dir, "runner.plist"), harbourDir: path.join(dir, "state") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runner service installation", () => {
  it("only offers the built-in service installer on macOS", () => {
    expect(supportsRunnerService("darwin")).toBe(true);
    expect(supportsRunnerService("linux")).toBe(false);
    expect(supportsRunnerService("win32")).toBe(false);
  });

  it("renders a launchd plist with persistent non-secret runner config", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/opt/node & tools/node",
      harbourBinPath: "/opt/harbour/bin/harbour.mjs",
      home: "/Users/test",
      harbourDir: "/Users/test/Harbour & state",
      env: {
        PATH: "/opt/bin:/usr/bin",
        HARBOUR_URL: "http://127.0.0.1:18080",
        HARBOUR_PORT: "18080",
        HARBOUR_HOST: "192.0.2.10",
        HARBOUR_RUNNER_LABELS: "local,gpu",
        HARBOUR_POOL_SIZE: "8",
      },
    });

    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>HARBOUR_HOME</key>");
    expect(plist).toContain("/Users/test/Harbour &amp; state");
    expect(plist).toContain("<key>HARBOUR_URL</key>");
    expect(plist).toContain("http://127.0.0.1:18080");
    expect(plist).toContain("<key>HARBOUR_PORT</key>");
    expect(plist).toContain("<key>HARBOUR_HOST</key>");
    expect(plist).toContain("<key>HARBOUR_RUNNER_LABELS</key>");
    expect(plist).toContain("<key>HARBOUR_POOL_SIZE</key>");
    expect(plist).toContain("/opt/node &amp; tools/node");
  });

  it("removes a newly written plist when launchctl bootstrap fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { target, harbourDir } = tempPaths();
    const execFile = (() => {
      throw new Error("bootstrap failed");
    }) as typeof execFileSync;

    expect(
      installRunner({
        platform: "darwin",
        target,
        harbourDir,
        domain: "gui/501",
        execFile,
      }),
    ).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("retries loading an existing but unloaded plist", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { target, harbourDir } = tempPaths();
    fs.writeFileSync(target, "existing plist");
    const calls: string[][] = [];
    const execFile = ((_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print") {
        throw Object.assign(new Error("not loaded"), { status: 113 });
      }
    }) as typeof execFileSync;

    expect(
      installRunner({
        platform: "darwin",
        target,
        harbourDir,
        domain: "gui/501",
        execFile,
      }),
    ).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["print", "bootstrap"]);
    expect(log).toHaveBeenCalledWith("Loaded the existing Harbour runner service.");
  });

  it("keeps the plist when an installed runner cannot be unloaded", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { target } = tempPaths();
    fs.writeFileSync(target, "existing plist");
    const execFile = ((_file: string, args: readonly string[]) => {
      if (args[0] === "bootout") throw new Error("bootout failed");
    }) as typeof execFileSync;

    expect(
      uninstallRunner({
        platform: "darwin",
        target,
        domain: "gui/501",
        execFile,
      }),
    ).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("keeps the plist when launchd state cannot be determined", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { target } = tempPaths();
    fs.writeFileSync(target, "existing plist");
    const execFile = (() => {
      throw Object.assign(new Error("permission denied"), { status: 1 });
    }) as typeof execFileSync;

    expect(
      uninstallRunner({
        platform: "darwin",
        target,
        domain: "gui/501",
        execFile,
      }),
    ).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("unloads an orphaned service even when its plist is already missing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { target } = tempPaths();
    let printCount = 0;
    const calls: string[][] = [];
    const execFile = ((_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "print" && printCount++ > 0) {
        throw Object.assign(new Error("not loaded"), { status: 113 });
      }
    }) as typeof execFileSync;

    expect(
      uninstallRunner({
        platform: "darwin",
        target,
        domain: "gui/501",
        execFile,
      }),
    ).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["print", "bootout", "print"]);
  });
});
