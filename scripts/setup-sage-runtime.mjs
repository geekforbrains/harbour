#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import YAML from "yaml";
import {
  ensureSageLocalFirstConfig,
  HERMES_SAGE_HOOK_COMMAND,
  HERMES_SAGE_HOOK_MATCHER,
  HERMES_SAGE_HOOK_PATH,
  SAGE_RUNTIME_SECURITY,
} from "../bin/lib/sage-guard.mjs";

const HERMES_DIR = join(homedir(), ".hermes");
const HERMES_CONFIG_PATH = join(HERMES_DIR, "config.yaml");
const HERMES_ALLOWLIST_PATH = join(HERMES_DIR, "shell-hooks-allowlist.json");

function readYamlFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  return YAML.parse(text) || {};
}

function writeYamlFile(path, value) {
  writeFileSync(path, YAML.stringify(value, { lineWidth: 0 }), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function readAllowlist() {
  if (!existsSync(HERMES_ALLOWLIST_PATH)) return { approvals: [] };
  try {
    const parsed = JSON.parse(readFileSync(HERMES_ALLOWLIST_PATH, "utf8"));
    return parsed && typeof parsed === "object"
      ? { ...parsed, approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [] }
      : { approvals: [] };
  } catch {
    return { approvals: [] };
  }
}

function hermesStyleMtime(path) {
  const python = spawnSync("python3", [
    "-c",
    "from datetime import datetime, timezone; import os, sys; print(datetime.fromtimestamp(os.path.getmtime(sys.argv[1]), tz=timezone.utc).isoformat().replace('+00:00', 'Z'))",
    path,
  ], { encoding: "utf8" });
  if (python.status === 0 && python.stdout.trim()) return python.stdout.trim();
  return statSync(path).mtime.toISOString();
}

function approveHermesHook() {
  const now = new Date().toISOString();
  const entry = {
    event: "pre_tool_call",
    command: HERMES_SAGE_HOOK_COMMAND,
    approved_at: now,
    script_mtime_at_approval: hermesStyleMtime(HERMES_SAGE_HOOK_PATH),
  };
  const allowlist = readAllowlist();
  allowlist.approvals = allowlist.approvals.filter(existing => !(
    existing
    && existing.event === entry.event
    && existing.command === entry.command
  ));
  allowlist.approvals.push(entry);
  writeFileSync(HERMES_ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(HERMES_ALLOWLIST_PATH, 0o600); } catch {}
}

function configureHermesHook() {
  mkdirSync(HERMES_DIR, { recursive: true });
  chmodSync(HERMES_SAGE_HOOK_PATH, 0o755);

  const config = readYamlFile(HERMES_CONFIG_PATH);
  const hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};
  const preToolCall = Array.isArray(hooks.pre_tool_call) ? hooks.pre_tool_call : [];
  const hookEntry = {
    command: HERMES_SAGE_HOOK_COMMAND,
    matcher: HERMES_SAGE_HOOK_MATCHER,
    timeout: 8,
  };
  hooks.pre_tool_call = [
    ...preToolCall.filter(entry => entry?.command !== HERMES_SAGE_HOOK_COMMAND),
    hookEntry,
  ];
  config.hooks = hooks;
  writeYamlFile(HERMES_CONFIG_PATH, config);
  approveHermesHook();
}

const configPath = ensureSageLocalFirstConfig();
configureHermesHook();

console.log(`SAGE runtime security configured (${SAGE_RUNTIME_SECURITY.version}).`);
console.log(`SAGE config: ${configPath}`);
console.log(`Hermes hook: ${HERMES_SAGE_HOOK_COMMAND}`);
console.log("OpenClaw: run `openclaw plugins install @gendigital/sage-openclaw@0.9.0 --pin --dangerously-force-unsafe-install` if the plugin is not already enabled.");
