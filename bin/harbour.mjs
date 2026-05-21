#!/usr/bin/env node

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { runAgents } from "./lib/runner.mjs";
import { installRunner, printRunnerStatus, repairRunner, uninstallRunner } from "./lib/install.mjs";
import { listRunners } from "./lib/config.mjs";
import { connectAgent } from "./lib/connect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const [,, command, subcommand, ...rest] = process.argv;

function usage() {
  console.log(`
harbour - Control plane for AI agents

Usage:
  harbour start              Start the server (production)
  harbour dev                Start the server (development)
  harbour agent list         List configured harbour agents
  harbour agent run          Poll all harbour agents once
  harbour agent status       Inspect local launchd runner health
  harbour agent repair       Repair stale local launchd runner paths
  harbour agent connect <blob>   Register a remote agent (paste the blob from
                                 harbour's "Connect remote runner" panel)
  harbour agent install      Install launchd polling
  harbour agent install --repair  Reinstall/repair launchd polling
  harbour agent uninstall    Remove the cron job
  `.trim());
}

async function main() {
  switch (command) {
    case "start": {
      const child = spawn("npx", ["next", "start", ...rest], { cwd: projectRoot, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "dev": {
      const child = spawn("npx", ["next", "dev", ...rest], { cwd: projectRoot, stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "agent": {
      switch (subcommand) {
        case "list":
          listRunners();
          break;
        case "run":
          await runAgents();
          break;
        case "status":
          printRunnerStatus();
          break;
        case "repair":
          repairRunner();
          break;
        case "connect":
          await connectAgent(rest[0]);
          break;
        case "install":
          installRunner({ repair: rest.includes("--repair") });
          break;
        case "uninstall":
          uninstallRunner();
          break;
        default:
          console.error(`Unknown agent command: ${subcommand}`);
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
