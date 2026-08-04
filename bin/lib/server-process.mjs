/**
 * Forward service-manager/terminal signals to a child server and clean up all
 * listeners when it exits. Kept separate from the CLI entry point so the
 * lifecycle behavior is testable without starting Next.js.
 *
 * @param {import("node:events").EventEmitter & {
 *   exitCode: number | null,
 *   signalCode: NodeJS.Signals | null,
 *   kill: (signal?: NodeJS.Signals) => boolean,
 * }} child
 * @param {{
 *   parent?: import("node:events").EventEmitter,
 *   signals?: NodeJS.Signals[],
 * }} [options]
 * @returns {Promise<{code: number, signal: NodeJS.Signals | null}>}
 */
export function monitorServerProcess(
  child,
  { parent = process, signals = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] } = {},
) {
  return new Promise((resolve, reject) => {
    const handlers = new Map(
      signals.map((signal) => [
        signal,
        () => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        },
      ]),
    );
    const cleanup = () => {
      for (const [signal, handler] of handlers) parent.off(signal, handler);
    };
    for (const [signal, handler] of handlers) parent.on(signal, handler);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code: code ?? 1, signal });
    });
  });
}
