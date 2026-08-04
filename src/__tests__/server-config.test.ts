import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunnerUrl } from "../../bin/lib/config.mjs";
import {
  buildNextServerArgs,
  DEFAULT_DEV_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  defaultServerUrl,
  initialRunnerUrl,
  resolveServerPort,
} from "../../bin/lib/server-config.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("server defaults", () => {
  it("uses Harbour's production port and loopback host explicitly", () => {
    expect(buildNextServerArgs("start", [], {})).toEqual([
      "start",
      "-p",
      String(DEFAULT_SERVER_PORT),
      "-H",
      DEFAULT_SERVER_HOST,
    ]);
    expect(defaultServerUrl({})).toBe(`http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`);
  });

  it("keeps bare development starts on the documented development port", () => {
    expect(buildNextServerArgs("dev", [], {})).toEqual([
      "dev",
      "-p",
      String(DEFAULT_DEV_PORT),
      "-H",
      DEFAULT_SERVER_HOST,
    ]);
  });

  it("honours Harbour-specific and conventional port env vars", () => {
    expect(resolveServerPort({ PORT: "18080" })).toBe("18080");
    expect(resolveServerPort({ PORT: "18080", HARBOUR_PORT: "19090" })).toBe("19090");
    expect(buildNextServerArgs("start", [], { HARBOUR_HOST: "0.0.0.0" })).toContain("0.0.0.0");
  });

  it("uses a concrete bind host for the local URL but maps wildcard binds to loopback", () => {
    expect(defaultServerUrl({ HARBOUR_HOST: "192.0.2.10" })).toBe(
      `http://192.0.2.10:${DEFAULT_SERVER_PORT}`,
    );
    expect(defaultServerUrl({ HARBOUR_HOST: "::1" })).toBe(`http://[::1]:${DEFAULT_SERVER_PORT}`);
    expect(defaultServerUrl({ HARBOUR_HOST: "0.0.0.0" })).toBe(
      `http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`,
    );
  });

  it("uses an explicit runner URL during setup", () => {
    expect(initialRunnerUrl({ HARBOUR_URL: "https://harbour.example/" })).toBe(
      "https://harbour.example",
    );
    expect(initialRunnerUrl({ PORT: "18080" })).toBe(`http://${DEFAULT_SERVER_HOST}:18080`);
  });

  it("leaves explicit Next port and hostname flags unchanged", () => {
    expect(
      buildNextServerArgs("start", ["--port", "20000", "--hostname=0.0.0.0"], {
        HARBOUR_PORT: "invalid",
      }),
    ).toEqual(["start", "--port", "20000", "--hostname=0.0.0.0"]);
    expect(buildNextServerArgs("start", ["-p20001", "-Hlocalhost"], {})).toEqual([
      "start",
      "-p20001",
      "-Hlocalhost",
    ]);
  });

  it("rejects invalid environment ports with an actionable error", () => {
    expect(() => resolveServerPort({ HARBOUR_PORT: "nope" })).toThrow(/integer from 1 to 65535/);
    expect(() => resolveServerPort({ PORT: "70000" })).toThrow(/integer from 1 to 65535/);
  });
});

describe("runner URL resolution", () => {
  function home() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-url-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses the shared local default when nothing is configured", () => {
    expect(resolveRunnerUrl({ env: {}, harbourDir: home() })).toBe(defaultServerUrl({}));
  });

  it("does not treat the server-only PORT alias as a runtime runner override", () => {
    expect(resolveRunnerUrl({ env: { PORT: "18080" }, harbourDir: home() })).toBe(
      defaultServerUrl({}),
    );
  });

  it("prefers persisted runner config, then explicit Harbour env overrides", () => {
    const dir = home();
    fs.writeFileSync(path.join(dir, "runner.url"), "http://127.0.0.1:18080/\n");
    expect(resolveRunnerUrl({ env: {}, harbourDir: dir })).toBe("http://127.0.0.1:18080");
    expect(resolveRunnerUrl({ env: { HARBOUR_PORT: "19090" }, harbourDir: dir })).toBe(
      "http://127.0.0.1:19090",
    );
    expect(
      resolveRunnerUrl({ env: { HARBOUR_URL: "https://harbour.example/" }, harbourDir: dir }),
    ).toBe("https://harbour.example");
  });
});
