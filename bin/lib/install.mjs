import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harbourBin = path.resolve(__dirname, "..", "harbour.mjs");

const PLIST_LABEL = "com.harbour.agent-runner";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const HARBOUR_DIR = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
const LOG_PATH = path.join(HARBOUR_DIR, "runner.log");
const ERR_LOG_PATH = path.join(HARBOUR_DIR, "runner.err.log");
const SNAPSHOT_DIR = path.join(HARBOUR_DIR, "launchagents", "snapshots");
const STALE_PATH_MARKERS = [
  "/Documents/OpenCode/",
  "/Documents/opencode/",
];

// Resolve node path
let nodePath;
try {
  nodePath = execSync("which node", { encoding: "utf-8" }).trim();
} catch {
  nodePath = process.execPath;
}

export function buildPlist(options = {}) {
  // launchd runs in the user's login session — full keychain & env access
  const resolvedNodePath = options.nodePath || nodePath;
  const resolvedHarbourBin = options.harbourBin || harbourBin;
  const resolvedLogPath = options.logPath || LOG_PATH;
  const resolvedErrLogPath = options.errLogPath || ERR_LOG_PATH;
  const resolvedHome = options.home || os.homedir();
  const resolvedPath = options.pathEnv || process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${resolvedNodePath}</string>
    <string>${resolvedHarbourBin}</string>
    <string>agent</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${resolvedLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${resolvedErrLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${resolvedPath}</string>
    <key>HOME</key>
    <string>${resolvedHome}</string>
  </dict>
</dict>
</plist>`;
}

function extractProgramArguments(plistText) {
  const match = plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(item => item[1]);
}

function currentTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function snapshotPlist(plistPath) {
  if (!fs.existsSync(plistPath)) return null;
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const snapshotPath = path.join(SNAPSHOT_DIR, `${PLIST_LABEL}.${currentTimestamp()}.plist`);
  fs.copyFileSync(plistPath, snapshotPath);
  return snapshotPath;
}

function runLaunchctl(args, { quiet = false } = {}) {
  return execFileSync("launchctl", args, { stdio: quiet ? "pipe" : "inherit", encoding: "utf-8" });
}

function isLaunchAgentLoaded(label = PLIST_LABEL) {
  try {
    const output = runLaunchctl(["list"], { quiet: true });
    return output.split(/\r?\n/).some(line => line.trim().endsWith(label));
  } catch {
    return false;
  }
}

export function inspectRunnerInstall(options = {}) {
  const plistPath = options.plistPath || PLIST_PATH;
  const expectedHarbourBin = options.harbourBin || harbourBin;
  const checkLoaded = options.checkLoaded !== false;
  const issues = [];
  const installed = fs.existsSync(plistPath);
  let programArguments = [];
  let runnerPath = null;

  if (!installed) {
    issues.push("missing-plist");
  } else {
    const plistText = fs.readFileSync(plistPath, "utf-8");
    programArguments = extractProgramArguments(plistText);
    runnerPath = programArguments[1] || null;

    if (programArguments.length < 4) {
      issues.push("missing-program-arguments");
    }
    if (runnerPath && STALE_PATH_MARKERS.some(marker => runnerPath.includes(marker))) {
      issues.push("stale-harbour-path");
    }
    if (runnerPath && runnerPath !== expectedHarbourBin) {
      issues.push("wrong-harbour-path");
    }
    if (runnerPath && !fs.existsSync(runnerPath)) {
      issues.push("missing-runner-target");
    }
    if (programArguments[0] && !fs.existsSync(programArguments[0])) {
      issues.push("missing-node-target");
    }
  }

  const loaded = checkLoaded ? isLaunchAgentLoaded() : null;
  if (installed && checkLoaded && !loaded) {
    issues.push("not-loaded");
  }

  return {
    label: PLIST_LABEL,
    plistPath,
    installed,
    loaded,
    healthy: installed && issues.length === 0,
    issues,
    runnerPath,
    expectedHarbourBin,
    programArguments,
    logPath: LOG_PATH,
    errLogPath: ERR_LOG_PATH,
  };
}

export function repairRunnerInstall(options = {}) {
  const plistPath = options.plistPath || PLIST_PATH;
  const dryRun = !!options.dryRun;
  const reload = options.reload !== false;
  const snapshotPath = dryRun ? null : snapshotPlist(plistPath);
  const plist = buildPlist(options);

  if (!dryRun) {
    const logDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);

    if (reload) {
      try {
        runLaunchctl(["bootout", `gui/${process.getuid()}/${PLIST_LABEL}`], { quiet: true });
      } catch { /* may not be loaded */ }
      try {
        runLaunchctl(["bootstrap", `gui/${process.getuid()}`, plistPath]);
      } catch {
        runLaunchctl(["load", plistPath]);
      }
    }
  }

  return {
    plistPath,
    snapshotPath,
    dryRun,
    reloaded: !dryRun && reload,
    status: dryRun
      ? inspectRunnerInstall({ plistPath, harbourBin: options.harbourBin, checkLoaded: false })
      : inspectRunnerInstall({ plistPath, harbourBin: options.harbourBin }),
  };
}

export function installRunner(options = {}) {
  const repair = !!options.repair;
  if (fs.existsSync(PLIST_PATH) && !repair) {
    console.log("Harbour agent runner is already installed.");
    console.log(`To repair a stale runner path, run: harbour agent repair`);
    return;
  }

  const result = repairRunnerInstall({ reload: true });

  console.log("Installed. Harbour agents will be polled every 60 seconds.");
  console.log(`Logs: ~/.harbour/runner.log`);
  if (result.snapshotPath) console.log(`Previous plist snapshot: ${result.snapshotPath}`);
}

export function repairRunner() {
  const before = inspectRunnerInstall();
  const result = repairRunnerInstall({ reload: true });
  const after = result.status;

  console.log("Harbour agent runner repair complete.");
  if (result.snapshotPath) console.log(`Snapshot: ${result.snapshotPath}`);
  console.log(`Plist: ${after.plistPath}`);
  console.log(`Runner: ${after.runnerPath}`);
  console.log(`Loaded: ${after.loaded ? "yes" : "no"}`);
  console.log(`Issues before: ${before.issues.length ? before.issues.join(", ") : "none"}`);
  console.log(`Issues after: ${after.issues.length ? after.issues.join(", ") : "none"}`);
}

export function printRunnerStatus() {
  const status = inspectRunnerInstall();
  console.log(`Harbour agent runner (${status.label})`);
  console.log(`  Plist: ${status.installed ? status.plistPath : "missing"}`);
  console.log(`  Loaded: ${status.loaded === null ? "unknown" : status.loaded ? "yes" : "no"}`);
  console.log(`  Runner: ${status.runnerPath || "missing"}`);
  console.log(`  Expected: ${status.expectedHarbourBin}`);
  console.log(`  Logs: ${status.logPath}`);
  console.log(`  Error log: ${status.errLogPath}`);
  console.log(`  Health: ${status.healthy ? "healthy" : "needs repair"}`);
  if (status.issues.length) console.log(`  Issues: ${status.issues.join(", ")}`);
}

export function uninstallRunner() {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log("Harbour agent runner is not installed.");
    return;
  }

  try {
    execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
  } catch { /* may already be unloaded */ }

  fs.unlinkSync(PLIST_PATH);
  console.log("Uninstalled. Harbour agent runner removed.");
}
