import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCapabilities } from "./providers.mjs";

const DEFAULT_URL = "http://localhost:3000";

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
 * remote). The base URL resolves HARBOUR_URL > runner.url file > localhost:3000.
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

function resolveRunnerUrl() {
  if (process.env.HARBOUR_URL) return process.env.HARBOUR_URL.replace(/\/$/, "");
  const file = runnerUrlFile();
  if (fs.existsSync(file)) {
    try {
      const url = fs.readFileSync(file, "utf-8").trim();
      if (url) return url.replace(/\/$/, "");
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_URL;
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

// Session tracking: run_id -> { sessionId, cli, cwd }
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
  console.log("  Start polling with `harbour install` (service) or `harbour run` (one-shot).");
}
