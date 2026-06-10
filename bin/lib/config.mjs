import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HARBOUR_DIR = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
const RUNNERS_FILE = path.join(HARBOUR_DIR, "runners.json");
const WORKFLOW_RUNNERS_FILE = path.join(HARBOUR_DIR, "workflow-runners.json");
const SESSIONS_FILE = path.join(HARBOUR_DIR, "sessions.json");

export function getHarbourDir() {
  return HARBOUR_DIR;
}

export function ensureDir() {
  if (!fs.existsSync(HARBOUR_DIR)) {
    fs.mkdirSync(HARBOUR_DIR, { recursive: true });
  }
}

export function loadRunnerConfigs() {
  if (!fs.existsSync(RUNNERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RUNNERS_FILE, "utf-8")).runners || [];
  } catch {
    return [];
  }
}

export function loadWorkflowRunnerConfigs() {
  if (!fs.existsSync(WORKFLOW_RUNNERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WORKFLOW_RUNNERS_FILE, "utf-8")).runners || [];
  } catch {
    return [];
  }
}

// Session tracking: run_id -> { sessionId, cli }
export function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSessions(sessions) {
  ensureDir();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function listRunners() {
  const runners = loadRunnerConfigs();
  if (runners.length === 0) {
    console.log("No harbour agents configured.");
    console.log("Create one from the dashboard or with: harbour agent add");
    return;
  }
  console.log(
    `\n  ${"NAME".padEnd(20)} ${"CLI".padEnd(10)} ${"MODEL".padEnd(15)} ${"THINKING".padEnd(10)} URL`,
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(10)} ${"─".repeat(15)} ${"─".repeat(10)} ${"─".repeat(30)}`,
  );
  for (const r of runners) {
    console.log(
      `  ${(r.name || r.agentId).padEnd(20)} ${(r.cli || "—").padEnd(10)} ${(r.model || "—").padEnd(15)} ${(r.thinking || "—").padEnd(10)} ${r.url}`,
    );
  }
  console.log();
}

export function listWorkflowRunners() {
  const runners = loadWorkflowRunnerConfigs();
  if (runners.length === 0) {
    console.log("No harbour workflow runners configured.");
    console.log(
      "Create one from the dashboard and connect it with: harbour workflow connect <blob>",
    );
    return;
  }
  console.log(`\n  ${"NAME".padEnd(20)} URL`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(30)}`);
  for (const r of runners) {
    console.log(`  ${(r.name || r.runnerId).padEnd(20)} ${r.url}`);
  }
  console.log();
}
