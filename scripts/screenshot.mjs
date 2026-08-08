#!/usr/bin/env node
// Regenerate public/screenshot.png (the README hero) from a real build.
//
// Runs against a throwaway HARBOUR_HOME under .screenshot/ seeded with
// synthetic demo data — never the operator's own database. Deterministic
// enough to re-run each release so the shot never drifts from the UI:
//
//   node scripts/screenshot.mjs
//
// Requires the Playwright chromium browser (already a devDependency).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotHome = path.join(repoRoot, ".screenshot", "home");
const PORT = 3040;
const EMAIL = "gavin@harbour.local";
const PASSWORD = "screenshot-password";

const env = { ...process.env, HARBOUR_HOME: shotHome, NODE_ENV: "production" };

fs.rmSync(path.join(repoRoot, ".screenshot"), { recursive: true, force: true });
fs.mkdirSync(shotHome, { recursive: true });

console.log("==> Seeding user");
const seed = spawnSync(
  "node",
  [
    "bin/harbour.mjs",
    "user",
    "create",
    "--email",
    EMAIL,
    "--name",
    "Gavin",
    "--password",
    PASSWORD,
  ],
  { cwd: repoRoot, env, stdio: "inherit" },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

console.log(`==> Starting server on :${PORT}`);
// The CLI bootstrap only creates users + runners; the server builds the rest of
// the schema at boot, so it has to be up before the demo rows go in.
const server = spawn("node", ["bin/harbour.mjs", "start"], {
  cwd: repoRoot,
  env: { ...env, HARBOUR_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`   ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`   ${d}`));

// Never leave the seeded server running — an orphan holds the port and the
// next run fails with EADDRINUSE.
let serverStopped = false;
const stopServer = () => {
  if (serverStopped) return;
  serverStopped = true;
  server.kill("SIGTERM");
};
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});
server.on("exit", (code) => {
  if (code && code !== 0 && !serverStopped) {
    console.error(`   server exited early with code ${code}`);
  }
});

const base = `http://127.0.0.1:${PORT}`;
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/login`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not come up");
}

// The server answers /login before its schema init has necessarily finished,
// so wait on the tables themselves rather than on the HTTP port.
async function waitForSchema() {
  const dbPath = path.join(shotHome, "harbour.db");
  for (let i = 0; i < 60; i++) {
    try {
      const probe = new Database(dbPath, { readonly: true });
      const row = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`)
        .get();
      probe.close();
      if (row) return;
    } catch {
      /* db not ready */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("schema was never initialized");
}

try {
  await waitForServer();
  await waitForSchema();
} catch (err) {
  server.kill("SIGTERM");
  throw err;
}

console.log("==> Seeding demo data");
const db = new Database(path.join(shotHome, "harbour.db"));
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
const now = Math.floor(Date.now() / 1000);
const mins = (n) => now - n * 60;

const projectId = randomUUID();
db.prepare(`INSERT INTO projects (id, name, slug) VALUES (?, ?, ?)`).run(projectId, "Acme", "acme");

// Colors are the dashboard's identity hues, one per agent.
const agents = [
  ["Marketing Agent", "marketing-agent", "green"],
  ["Support Agent", "support-agent", "orange"],
  ["DevOps Agent", "devops-agent", "pink"],
  ["Content Agent", "content-agent", "yellow"],
].map(([name, slug, color]) => {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, project_id, name, slug, cli, color, permissions) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, projectId, name, slug, "claude", color, "enforced");
  return { id, name };
});
const agent = Object.fromEntries(agents.map((a) => [a.name, a.id]));

function job(name, agentId, schedule) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, project_id, agent_id, name, kind, instructions, schedule, active)
     VALUES (?,?,?,?,'agent',?,?,1)`,
  ).run(id, projectId, agentId, name, "…", schedule);
  return id;
}

function run({ jobId, agentId, status, title, scheduledFor, claimedAt, completedAt }) {
  db.prepare(
    `INSERT INTO runs (id, project_id, job_id, agent_id, status, title, scheduled_for, claimed_at, completed_at, attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
  ).run(
    randomUUID(),
    projectId,
    jobId,
    agentId,
    status,
    title,
    scheduledFor ?? null,
    claimedAt ?? null,
    completedAt ?? null,
    claimedAt ?? scheduledFor ?? now,
    completedAt ?? claimedAt ?? scheduledFor ?? now,
  );
}

const jCampaign = job("Competitor campaign scan", agent["Marketing Agent"], '{"every":1440}');
const jMetrics = job(
  "Quarterly metrics report",
  agent["Support Agent"],
  '{"days":[1],"time":"09:00"}',
);
const jBackup = job(
  "Nightly backup verification",
  agent["DevOps Agent"],
  '{"days":[0,1,2,3,4,5,6],"time":"02:00"}',
);
const jDeps = job("Dependency upgrades", agent["DevOps Agent"], '{"every":10080}');
const jBlog = job("Weekly blog draft", agent["Content Agent"], '{"days":[3],"time":"10:00"}');
const jDeploy = job("Deploy monitor", agent["DevOps Agent"], '{"every":60}');

run({
  jobId: jCampaign,
  agentId: agent["Marketing Agent"],
  status: "running",
  title: "Analyzing 4 rival Q2 ad campaigns",
  claimedAt: mins(8),
});
run({
  jobId: jMetrics,
  agentId: agent["Support Agent"],
  status: "scheduled",
  title: "Quarterly metrics report · 9:00am",
  scheduledFor: now + 3600,
});
run({
  jobId: jBackup,
  agentId: agent["DevOps Agent"],
  status: "scheduled",
  title: "Nightly backup verification · 2:00am",
  scheduledFor: now + 7200,
});
run({
  jobId: jDeps,
  agentId: agent["DevOps Agent"],
  status: "waiting",
  title: "Upgrade Node.js to v24 — approval needed",
  claimedAt: mins(120),
});
run({
  jobId: jBlog,
  agentId: agent["Content Agent"],
  status: "pending",
  title: "Draft: “Shipping faster with agents”",
  claimedAt: mins(60),
});
run({
  jobId: jDeploy,
  agentId: agent["DevOps Agent"],
  status: "failed",
  title: "Deploy check failed — dashboard returned 502",
  claimedAt: mins(20),
  completedAt: mins(18),
});
run({
  jobId: jCampaign,
  agentId: agent["Marketing Agent"],
  status: "done",
  title: "Summarized 12 competitor posts",
  claimedAt: mins(95),
  completedAt: mins(92),
});
// The bootstrap provisions a local runner but nothing has polled with it yet.
// Mark it healthy so the dashboard doesn't advertise a disconnected runner.
db.prepare(`UPDATE runners SET last_polled_at = ?, capabilities = ? WHERE tier = 'local'`).run(
  mins(1),
  JSON.stringify({ kinds: ["agent", "workflow"], clis: ["claude", "codex"], labels: ["local"] }),
);

db.close();

try {
  console.log("==> Capturing");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });

  // Log in through the real form so the session cookie is set the way a
  // visitor's would be.
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });

  // The dashboard root — runs grouped by status — is the README hero, not the
  // filterable /runs history page.
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Runs", exact: true }).waitFor();
  // Let relative timestamps and the status groups settle before capturing.
  await page.waitForTimeout(1500);

  const out = path.join(repoRoot, "public", "screenshot.png");
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`==> Wrote ${path.relative(repoRoot, out)}`);
} finally {
  stopServer();
}
