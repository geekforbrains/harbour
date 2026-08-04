import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { monitorServerProcess } from "../../bin/lib/server-process.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

describe("server process lifecycle", () => {
  it("forwards termination signals and removes listeners after exit", async () => {
    const parent = new EventEmitter();
    const child = new FakeChild();
    const result = monitorServerProcess(child, { parent });

    expect(parent.listenerCount("SIGTERM")).toBe(1);
    parent.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    await expect(result).resolves.toEqual({ code: 1, signal: "SIGTERM" });
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"]) {
      expect(parent.listenerCount(signal)).toBe(0);
    }
  });

  it("propagates spawn errors and removes listeners", async () => {
    const parent = new EventEmitter();
    const child = new FakeChild();
    const result = monitorServerProcess(child, { parent });

    child.emit("error", new Error("spawn failed"));
    await expect(result).rejects.toThrow("spawn failed");
    expect(parent.listenerCount("SIGTERM")).toBe(0);
  });
});
