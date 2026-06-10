import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harbourBin = path.resolve(__dirname, "..", "harbour.mjs");

const PLIST_LABEL = "com.harbour.agent-runner";
const WORKFLOW_PLIST_LABEL = "com.harbour.workflow-runner";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const WORKFLOW_PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${WORKFLOW_PLIST_LABEL}.plist`,
);
const HARBOUR_DIR = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
const LOG_PATH = path.join(HARBOUR_DIR, "runner.log");
const ERR_LOG_PATH = path.join(HARBOUR_DIR, "runner.err.log");
const WORKFLOW_LOG_PATH = path.join(HARBOUR_DIR, "workflow-runner.log");
const WORKFLOW_ERR_LOG_PATH = path.join(HARBOUR_DIR, "workflow-runner.err.log");

// Resolve node path
let nodePath;
try {
  nodePath = execSync("which node", { encoding: "utf-8" }).trim();
} catch {
  nodePath = process.execPath;
}

function buildPlist({
  label = PLIST_LABEL,
  args = ["agent", "run"],
  logPath = LOG_PATH,
  errLogPath = ERR_LOG_PATH,
} = {}) {
  // launchd runs in the user's login session — full keychain & env access
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${harbourBin}</string>
    ${args.map((arg) => `<string>${arg}</string>`).join("\n    ")}
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
</dict>
</plist>`;
}

function installLaunchAgent({ plistPath, label, args, logPath, errLogPath, noun, command }) {
  if (fs.existsSync(plistPath)) {
    console.log(`Harbour ${noun} runner is already installed.`);
    console.log(`To reinstall, run: harbour ${command} uninstall && harbour ${command} install`);
    return;
  }

  // Ensure log directory exists
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // Write plist
  fs.writeFileSync(plistPath, buildPlist({ label, args, logPath, errLogPath }));

  // Load with launchctl
  try {
    execSync(`launchctl load ${plistPath}`, { stdio: "inherit" });
  } catch {
    console.error(`Failed to load launch agent. Try manually: launchctl load ${plistPath}`);
    return;
  }

  console.log(`Installed. Harbour ${noun} runner will be polled every 60 seconds.`);
  console.log(`Logs: ${logPath}`);
}

function uninstallLaunchAgent({ plistPath, noun }) {
  if (!fs.existsSync(plistPath)) {
    console.log(`Harbour ${noun} runner is not installed.`);
    return;
  }

  try {
    execSync(`launchctl unload ${plistPath}`, { stdio: "inherit" });
  } catch {
    /* may already be unloaded */
  }

  fs.unlinkSync(plistPath);
  console.log(`Uninstalled. Harbour ${noun} runner removed.`);
}

export function installRunner() {
  installLaunchAgent({
    plistPath: PLIST_PATH,
    label: PLIST_LABEL,
    args: ["agent", "run"],
    logPath: LOG_PATH,
    errLogPath: ERR_LOG_PATH,
    noun: "agent",
    command: "agent",
  });
}

export function uninstallRunner() {
  uninstallLaunchAgent({ plistPath: PLIST_PATH, noun: "agent" });
}

export function installWorkflowRunner() {
  installLaunchAgent({
    plistPath: WORKFLOW_PLIST_PATH,
    label: WORKFLOW_PLIST_LABEL,
    args: ["workflow", "run"],
    logPath: WORKFLOW_LOG_PATH,
    errLogPath: WORKFLOW_ERR_LOG_PATH,
    noun: "workflow",
    command: "workflow",
  });
}

export function uninstallWorkflowRunner() {
  uninstallLaunchAgent({ plistPath: WORKFLOW_PLIST_PATH, noun: "workflow" });
}
