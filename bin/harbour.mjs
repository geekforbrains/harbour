#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAdminCreate, runSetup } from "./lib/bootstrap.mjs";
import { printRunnerStatus } from "./lib/config.mjs";
import { connectRunner } from "./lib/connect.mjs";
import { installRunner, uninstallRunner } from "./lib/install.mjs";
import { runPool } from "./lib/runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const [, , command, ...rest] = process.argv;

function usage() {
  console.log(
    `
harbour - Control plane for AI agents

Usage:
  harbour start              Start the server (production)
  harbour dev                Start the server (development)
  harbour setup              Create the first instance admin + local runner (first-run)
  harbour admin create       Create an instance admin (non-interactive flags)
  harbour run                Claim and run all due work once (the runner)
  harbour connect <blob>     Enroll a remote runner from a minted credential blob
  harbour install            Schedule the runner as a service (polls every 60s)
  harbour uninstall          Remove the runner service
  harbour status             Show the runner's provisioning status
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

async function main() {
  checkNode();
  switch (command) {
    case "start": {
      const child = spawn("npx", ["next", "start", ...rest], {
        cwd: projectRoot,
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "dev": {
      const child = spawn("npx", ["next", "dev", ...rest], { cwd: projectRoot, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "setup": {
      await runSetup(rest.filter(Boolean));
      break;
    }
    case "admin": {
      if (rest[0] === "create") {
        await runAdminCreate(rest.slice(1));
      } else {
        console.error(`Unknown admin command: ${rest[0]}`);
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
      installRunner();
      break;
    case "uninstall":
      uninstallRunner();
      break;
    case "status":
      printRunnerStatus();
      break;
    default:
      usage();
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
