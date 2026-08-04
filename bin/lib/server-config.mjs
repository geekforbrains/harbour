// Stable project-wide production port: 1-HARB (4272 on a phone keypad).
export const DEFAULT_SERVER_PORT = 14272;
export const DEFAULT_DEV_PORT = 3001;
export const DEFAULT_SERVER_HOST = "127.0.0.1";

/** @param {string} value */
function stripTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

/** @param {string} host */
function hostForUrl(host) {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return DEFAULT_SERVER_HOST;
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** @param {string[]} args @param {string} shortName @param {string} longName */
function hasOption(args, shortName, longName) {
  return args.some(
    (arg) =>
      arg === shortName ||
      arg === longName ||
      arg.startsWith(`${shortName}=`) ||
      (arg.startsWith(shortName) && arg.length > shortName.length) ||
      arg.startsWith(`${longName}=`),
  );
}

/**
 * Resolve the server port from Harbour's explicit env, Next's standard env, or the default.
 * @param {Record<string, string | undefined>} [env]
 * @param {number} [fallback]
 */
export function resolveServerPort(env = process.env, fallback = DEFAULT_SERVER_PORT) {
  const raw = env.HARBOUR_PORT || env.PORT;
  if (!raw) return String(fallback);

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Harbour port "${raw}". Use an integer from 1 to 65535.`);
  }
  return String(port);
}

/**
 * Build explicit Next CLI args so start/dev never fall back to Next's port 3000 or 0.0.0.0.
 * @param {"start" | "dev"} mode
 * @param {string[]} [args]
 * @param {Record<string, string | undefined>} [env]
 */
export function buildNextServerArgs(mode, args = [], env = process.env) {
  if (mode !== "start" && mode !== "dev") {
    throw new Error(`Invalid Next server mode "${mode}".`);
  }

  const resolved = [mode, ...args];
  if (!hasOption(args, "-p", "--port")) {
    resolved.push(
      "-p",
      resolveServerPort(env, mode === "dev" ? DEFAULT_DEV_PORT : DEFAULT_SERVER_PORT),
    );
  }
  if (!hasOption(args, "-H", "--hostname")) {
    resolved.push("-H", env.HARBOUR_HOST || DEFAULT_SERVER_HOST);
  }
  return resolved;
}

/**
 * The local URL a bundled runner should use when no explicit runner URL is configured.
 * @param {Record<string, string | undefined>} [env]
 */
export function defaultServerUrl(env = process.env) {
  const bindHost = env.HARBOUR_HOST?.trim() || DEFAULT_SERVER_HOST;
  return `http://${hostForUrl(bindHost)}:${resolveServerPort(env)}`;
}

/**
 * URL persisted for the bundled runner during first-run setup.
 * HARBOUR_URL is authoritative; otherwise use the configured local bind/port.
 * @param {Record<string, string | undefined>} [env]
 */
export function initialRunnerUrl(env = process.env) {
  return env.HARBOUR_URL ? stripTrailingSlash(env.HARBOUR_URL) : defaultServerUrl(env);
}
