#!/usr/bin/env node
// Playwright webServer command: reset the isolated e2e Harbour home, seed the
// instance admin, then start a dev server on the e2e port. Keeping reset +
// seed + start in one script avoids ordering races between Playwright's
// globalSetup and webServer startup.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eHome = path.join(repoRoot, ".e2e", "home");

const env = {
  ...process.env,
  HARBOUR_HOME: e2eHome,
  NODE_ENV: "development",
};

fs.rmSync(path.join(repoRoot, ".e2e"), { recursive: true, force: true });
fs.mkdirSync(e2eHome, { recursive: true });

const seed = spawnSync(
  "node",
  [
    "bin/harbour.mjs",
    "admin",
    "create",
    "--email",
    "admin@e2e.local",
    "--name",
    "E2E Admin",
    "--password",
    "e2e-test-password",
  ],
  { cwd: repoRoot, env, stdio: "inherit" },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

const server = spawn("npx", ["next", "dev", "-p", "3030"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
server.on("exit", (code) => process.exit(code ?? 0));
