#!/usr/bin/env node

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { runAgents } from "./lib/runner.mjs";
import { installRunner, uninstallRunner } from "./lib/install.mjs";
import { listRunners } from "./lib/config.mjs";
import { connectAgent } from "./lib/connect.mjs";
import { runSetup, runAdminCreate } from "./lib/bootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const [,, command, subcommand, ...rest] = process.argv;

function usage() {
  console.log(`
harbour - Control plane for AI agents

Usage:
  harbour start              Start the server (production)
  harbour dev                Start the server (development)
  harbour setup              Create the first instance admin (interactive, first-run)
  harbour admin create       Create an instance admin (non-interactive flags)
  harbour agent list         List configured harbour agents
  harbour agent run          Poll all harbour agents once
  harbour agent connect <blob>   Register a remote agent (paste the blob from
                                 harbour's "Connect remote runner" panel)
  harbour agent install      Install cron job for automatic polling
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
    case "setup": {
      await runSetup([subcommand, ...rest].filter(Boolean));
      break;
    }
    case "admin": {
      switch (subcommand) {
        case "create":
          await runAdminCreate(rest);
          break;
        default:
          console.error(`Unknown admin command: ${subcommand}`);
          usage();
          process.exit(1);
      }
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
        case "connect":
          await connectAgent(rest[0]);
          break;
        case "install":
          installRunner();
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
