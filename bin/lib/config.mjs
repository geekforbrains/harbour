import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCapabilities } from "./providers.mjs";
import { defaultServerUrl } from "./server-config.mjs";

// Resolve HARBOUR_HOME (and the files under it) LIVE on every call — never frozen
// at module load — so an env override (e.g. a worktree or a test) always wins.
export function getHarbourDir() {
  return process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
}
const runnerTokenFile = () => path.join(getHarbourDir(), "runner.token");
const runnerUrlFile = () => path.join(getHarbourDir(), "runner.url");
const sessionsFile = () => path.join(getHarbourDir(), "sessions.json");

export function ensureDir() {
  const dir = getHarbourDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * The bundled runner's credentials: its bearer token (`hbrn_…`) and where to
 * reach Harbour. The token is the only secret on disk (0600, like the encryption
 * key); the URL is non-secret. Returns null when no token is present (the runner
 * hasn't been provisioned — `harbour setup` for local, `harbour connect` for
 * remote). The base URL resolves HARBOUR_URL > HARBOUR_PORT local override >
 * runner.url file > the shared local server default. PORT is server-only at
 * runtime; setup writes its effective value to runner.url when initially used.
 */
export function loadRunnerCredentials() {
  const file = runnerTokenFile();
  if (!fs.existsSync(file)) return null;
  let token;
  try {
    token = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  if (!token) return null;
  return { token, url: resolveRunnerUrl() };
}

/**
 * @param {{env?: Record<string, string | undefined>, harbourDir?: string}} [options]
 */
export function resolveRunnerUrl({ env = process.env, harbourDir = getHarbourDir() } = {}) {
  if (env.HARBOUR_URL) return env.HARBOUR_URL.replace(/\/$/, "");
  if (env.HARBOUR_PORT) return defaultServerUrl(env);
  const file = path.join(harbourDir, "runner.url");
  if (fs.existsSync(file)) {
    try {
      const url = fs.readFileSync(file, "utf-8").trim();
      if (url) return url.replace(/\/$/, "");
    } catch {
      /* fall through to default */
    }
  }
  // PORT is a conventional server-only alias. Setup persists its effective
  // value in runner.url; don't let an unrelated PORT in a runner environment
  // silently redirect an unconfigured runner later.
  return defaultServerUrl({});
}

/**
 * Persist the runner's token (0600) and, when given, its URL. Used by `harbour
 * setup` (local auto-provision) and `harbour connect` (remote enrollment).
 */
export function saveRunnerCredentials({ token, url }) {
  ensureDir();
  const tokenFile = runnerTokenFile();
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  if (url) fs.writeFileSync(runnerUrlFile(), `${url.replace(/\/$/, "")}\n`);
}

// Session tracking:
// run_id -> { sessionId, cli, cwd, configFingerprint? }
// configFingerprint is a digest of non-secret provider/model/variant metadata.
export function loadSessions() {
  const file = sessionsFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSessions(sessions) {
  ensureDir();
  fs.writeFileSync(sessionsFile(), JSON.stringify(sessions, null, 2));
}

/**
 * Decide whether a saved CLI session can safely resume under the live config.
 * Legacy Claude/Codex records had no fingerprint and remain compatible; a
 * provider that requires fingerprints (OpenCode) starts fresh when one is
 * absent or changed. A cross-CLI resume is always invalid.
 *
 * @param {{ sessionId?: string, cli?: string, configFingerprint?: string, cwd?: string } | null | undefined} session
 * @param {{ cli?: string, configFingerprint?: string | null, requireFingerprint?: boolean }} options
 */
export function isSessionCompatible(
  session,
  { cli, configFingerprint = null, requireFingerprint = false } = {},
) {
  if (!session?.sessionId || !cli) return false;
  if (session.cli && session.cli !== cli) return false;
  if (requireFingerprint) {
    return !!configFingerprint && session.configFingerprint === configFingerprint;
  }
  if (session.configFingerprint && configFingerprint) {
    return session.configFingerprint === configFingerprint;
  }
  return true;
}

/** Print the runner's provisioning status (`harbour status`). */
export function printRunnerStatus() {
  const creds = loadRunnerCredentials();
  if (!creds) {
    console.log("Runner: not provisioned.");
    console.log("  Local:  run `harbour setup` (creates the local runner token).");
    console.log("  Remote: run `harbour connect <blob>` with a minted runner credential.");
    return;
  }
  console.log("Runner: provisioned.");
  console.log(`  Token: ${runnerTokenFile()}`);
  console.log(`  URL:   ${creds.url}`);
  const caps = detectCapabilities();
  console.log(
    `  CLIs on PATH: ${caps.clis.length ? caps.clis.join(", ") : "none — agent runs need a CLI on PATH"}`,
  );
  if (process.platform === "darwin") {
    console.log("  Start polling with `harbour install` (service) or `harbour run` (one-shot).");
  } else {
    console.log(
      "  Start polling with the documented systemd unit (Linux) or `harbour run` (one-shot).",
    );
  }
}
