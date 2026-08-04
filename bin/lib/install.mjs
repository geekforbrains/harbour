import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHarbourDir } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harbourBin = path.resolve(__dirname, "..", "harbour.mjs");

export const PLIST_LABEL = "com.harbour.runner";

function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

function launchdDomain(uid = process.getuid()) {
  return `gui/${uid}`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function supportsRunnerService(platform = process.platform) {
  return platform === "darwin";
}

/**
 * @param {{
 *   nodePath?: string,
 *   harbourBinPath?: string,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   harbourDir?: string
 * }} [options]
 */
export function buildLaunchdPlist({
  nodePath = process.execPath,
  harbourBinPath = harbourBin,
  home = os.homedir(),
  env = process.env,
  harbourDir = getHarbourDir(),
} = {}) {
  // launchd runs in the user's login session — full keychain & env access. One
  // service, `harbour run`, claims and drains all due work each tick.
  const environment = {
    PATH: env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    HOME: home,
    HARBOUR_HOME: harbourDir,
  };
  for (const key of [
    "HARBOUR_URL",
    "HARBOUR_PORT",
    "HARBOUR_HOST",
    "HARBOUR_RUNNER_LABELS",
    "HARBOUR_POOL_SIZE",
  ]) {
    if (env[key]) environment[key] = env[key];
  }
  const environmentXml = Object.entries(environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const logPath = path.join(harbourDir, "runner.log");
  const errLogPath = path.join(harbourDir, "runner.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(harbourBinPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLogPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>`;
}

function launchdServiceState(execFile, serviceTarget) {
  try {
    execFile("launchctl", ["print", serviceTarget], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return "loaded";
  } catch (error) {
    const status = error?.status;
    const detail = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    if (status === 113 || detail.includes("Could not find service")) return "absent";
    return "unknown";
  }
}

/**
 * @param {{
 *   platform?: string,
 *   target?: string,
 *   harbourDir?: string,
 *   domain?: string,
 *   execFile?: typeof execFileSync,
 * }} [options]
 */
export function installRunner({
  platform = process.platform,
  target = plistPath(),
  harbourDir = getHarbourDir(),
  domain = platform === "darwin" ? launchdDomain() : "",
  execFile = execFileSync,
} = {}) {
  if (!supportsRunnerService(platform)) {
    console.error(
      "Automatic runner service installation is supported on macOS only. On Linux, use the systemd unit in docs/guides/deploy-to-production.md.",
    );
    return false;
  }

  const serviceTarget = `${domain}/${PLIST_LABEL}`;
  if (fs.existsSync(target)) {
    const state = launchdServiceState(execFile, serviceTarget);
    if (state === "loaded") {
      console.log("Harbour runner is already installed and loaded.");
      console.log("To reinstall, run: harbour uninstall && harbour install");
      return true;
    }
    if (state === "unknown") {
      console.error("Could not determine whether the Harbour runner is loaded; no changes made.");
      return false;
    }
    try {
      execFile("launchctl", ["bootstrap", domain, target], { stdio: "inherit" });
      console.log("Loaded the existing Harbour runner service.");
      return true;
    } catch {
      console.error(
        `The runner plist exists but could not be loaded. Fix or remove it, then retry: ${target}`,
      );
      return false;
    }
  }
  const logDir = harbourDir;
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildLaunchdPlist({ harbourDir }));
  try {
    execFile("launchctl", ["bootstrap", domain, target], { stdio: "inherit" });
  } catch {
    fs.unlinkSync(target);
    console.error(
      `Failed to load the launch agent; the new plist was removed. Retry with: harbour install`,
    );
    return false;
  }
  console.log("Installed. Harbour runner will poll for work every 60 seconds.");
  console.log(`Logs: ${path.join(logDir, "runner.log")}`);
  return true;
}

/**
 * @param {{
 *   platform?: string,
 *   target?: string,
 *   domain?: string,
 *   execFile?: typeof execFileSync,
 * }} [options]
 */
export function uninstallRunner({
  platform = process.platform,
  target = plistPath(),
  domain = platform === "darwin" ? launchdDomain() : "",
  execFile = execFileSync,
} = {}) {
  if (!supportsRunnerService(platform)) {
    console.error(
      "Automatic runner service uninstall is supported on macOS only. On Linux, remove the systemd unit configured for Harbour.",
    );
    return false;
  }

  const hasPlist = fs.existsSync(target);
  const serviceTarget = `${domain}/${PLIST_LABEL}`;
  const state = launchdServiceState(execFile, serviceTarget);
  if (state === "unknown") {
    console.error("Could not determine whether the Harbour runner is loaded; no changes made.");
    return false;
  }
  if (state === "loaded") {
    try {
      execFile("launchctl", ["bootout", serviceTarget], { stdio: "inherit" });
    } catch {
      console.error("Failed to unload the Harbour runner; its plist was left in place.");
      return false;
    }
    if (launchdServiceState(execFile, serviceTarget) !== "absent") {
      console.error("The Harbour runner may still be loaded; its plist was left in place.");
      return false;
    }
  }
  if (hasPlist) fs.unlinkSync(target);
  if (!hasPlist && state === "absent") {
    console.log("Harbour runner is not installed.");
    return true;
  }
  console.log(
    hasPlist
      ? "Uninstalled. Harbour runner removed."
      : "Uninstalled a loaded Harbour runner that had no plist on disk.",
  );
  return true;
}
