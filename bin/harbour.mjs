#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup, runUserCreate } from "./lib/bootstrap.mjs";
import { printRunnerStatus } from "./lib/config.mjs";
import { connectRunner } from "./lib/connect.mjs";
import { installRunner, uninstallRunner } from "./lib/install.mjs";
import { runPolicyCheck } from "./lib/policy-cli.mjs";
import { runPool } from "./lib/runner.mjs";
import { buildNextServerArgs } from "./lib/server-config.mjs";
import { monitorServerProcess } from "./lib/server-process.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const [, , command, ...rest] = process.argv;

function usage() {
  console.log(
    `
harbour - Control plane for AI agents

Usage:
  harbour start              Start the server (production; default 127.0.0.1:4272)
  harbour dev                Start the server (development; default 127.0.0.1:3001)
  harbour setup              Create the first user + local runner (first-run)
  harbour user create        Create a user (non-interactive flags)
  harbour run                Claim and run all due work once (the runner)
  harbour connect <blob>     Enroll a remote runner from a minted credential blob
  harbour install            Schedule the runner with launchd (macOS; every 60s)
  harbour uninstall          Remove the launchd runner service (macOS)
  harbour status             Show the runner's provisioning status
  harbour policy check       Validate every agent's permission policy (exit 1 on failures)
  `.trim(),
  );
}

// Harbour targets Node 24 LTS. A mismatched Node is the usual cause of the
// better-sqlite3 NODE_MODULE_VERSION error, so warn early (non-blocking — the
// DB-open path raises a precise, actionable error if the binary won't load).
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    console.warn(
      `⚠ Harbour targets Node 24 LTS — you're on ${process.version}. If you hit a better-sqlite3 load error, run 'npm rebuild better-sqlite3' under this Node.`,
    );
  }
}

function runNext(mode, args) {
  const child = spawn(process.execPath, [nextBin, ...buildNextServerArgs(mode, args)], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return monitorServerProcess(child).then(({ code, signal }) => {
    if (signal) process.kill(process.pid, signal);
    return code;
  });
}

async function main() {
  checkNode();
  switch (command) {
    case "start": {
      process.exitCode = await runNext("start", rest);
      break;
    }
    case "dev": {
      process.exitCode = await runNext("dev", rest);
      break;
    }
    case "setup": {
      await runSetup(rest.filter(Boolean));
      break;
    }
    case "user": {
      if (rest[0] === "create") {
        await runUserCreate(rest.slice(1));
      } else {
        console.error(`Unknown user command: ${rest[0]}`);
        usage();
        process.exit(1);
      }
      break;
    }
    case "run":
      await runPool();
      break;
    case "connect":
      await connectRunner(rest[0]);
      break;
    case "install":
      if (!installRunner()) process.exitCode = 1;
      break;
    case "uninstall":
      if (!uninstallRunner()) process.exitCode = 1;
      break;
    case "status":
      printRunnerStatus();
      break;
    case "policy": {
      if (rest[0] === "check") {
        process.exitCode = await runPolicyCheck(rest.slice(1));
      } else {
        console.error(`Unknown policy command: ${rest[0]}`);
        usage();
        process.exit(1);
      }
      break;
    }
    default:
      usage();
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
