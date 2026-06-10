import fs from "node:fs";
import path from "node:path";
import { ensureDir, getHarbourDir, loadRunnerConfigs } from "./config.mjs";

// Identity-only: the agent's cli/model/thinking come live from the /next
// payload, so the blob just needs to say who the agent is and where harbour is.
const REQUIRED_FIELDS = ["url", "agentId", "apiKey", "name"];
const WORKFLOW_REQUIRED_FIELDS = ["url", "runnerId", "apiKey", "name"];

function decodeBlob(blob) {
  let json;
  try {
    json = Buffer.from(blob, "base64").toString("utf-8");
  } catch {
    throw new Error("Blob is not valid base64");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Blob does not decode to valid JSON");
  }
  for (const f of REQUIRED_FIELDS) {
    if (!parsed[f]) throw new Error(`Blob is missing required field: ${f}`);
  }
  return parsed;
}

function decodeWorkflowBlob(blob) {
  let json;
  try {
    json = Buffer.from(blob, "base64").toString("utf-8");
  } catch {
    throw new Error("Blob is not valid base64");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Blob does not decode to valid JSON");
  }
  for (const f of WORKFLOW_REQUIRED_FIELDS) {
    if (!parsed[f]) throw new Error(`Blob is missing required field: ${f}`);
  }
  return parsed;
}

async function verifyAuth(url, agentId, apiKey) {
  const endpoint = `${url.replace(/\/$/, "")}/api/agents/${agentId}/next?peek=true`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new Error(`Cannot reach ${endpoint}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Authentication failed (HTTP ${res.status}) — the API key is invalid or doesn't match this agent`,
    );
  }
  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status} — expected 200 on peek`);
  }
}

async function verifyWorkflowAuth(url, apiKey) {
  const endpoint = `${url.replace(/\/$/, "")}/api/workflows/next?peek=true`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new Error(`Cannot reach ${endpoint}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Authentication failed (HTTP ${res.status}) — the workflow runner API key is invalid`,
    );
  }
  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status} — expected 200 on workflow poll`);
  }
}

function writeRunner(config) {
  ensureDir();
  const runners = loadRunnerConfigs();
  const existing = runners.findIndex((r) => r.agentId === config.agentId);
  const entry = {
    agentId: config.agentId,
    name: config.name,
    apiKey: config.apiKey,
    url: config.url,
  };
  if (existing >= 0) {
    runners[existing] = entry;
  } else {
    runners.push(entry);
  }
  const file = path.join(getHarbourDir(), "runners.json");
  fs.writeFileSync(file, JSON.stringify({ runners }, null, 2));
  return { file, replaced: existing >= 0 };
}

function writeWorkflowRunner(config) {
  ensureDir();
  const file = path.join(getHarbourDir(), "workflow-runners.json");
  let runners = [];
  if (fs.existsSync(file)) {
    try {
      runners = JSON.parse(fs.readFileSync(file, "utf-8")).runners || [];
    } catch {
      runners = [];
    }
  }
  const existing = runners.findIndex((r) => r.runnerId === config.runnerId);
  const entry = {
    runnerId: config.runnerId,
    name: config.name,
    apiKey: config.apiKey,
    url: config.url,
  };
  if (existing >= 0) {
    runners[existing] = entry;
  } else {
    runners.push(entry);
  }
  fs.writeFileSync(file, JSON.stringify({ runners }, null, 2));
  return { file, replaced: existing >= 0 };
}

export async function connectAgent(blob) {
  if (!blob) {
    console.error("Usage: harbour agent connect <base64-blob>");
    console.error("Copy the blob from the 'Connect remote runner' panel in the harbour dashboard.");
    process.exit(1);
  }

  let config;
  try {
    config = decodeBlob(blob);
  } catch (err) {
    console.error(`Blob decode failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`Connecting to ${config.url} as agent "${config.name}" (${config.agentId})…`);

  try {
    await verifyAuth(config.url, config.agentId, config.apiKey);
  } catch (err) {
    console.error(`Verification failed: ${err.message}`);
    process.exit(1);
  }

  const { file, replaced } = writeRunner(config);
  console.log(`${replaced ? "Updated" : "Added"} runner config for "${config.name}" in ${file}`);
  console.log();
  console.log(`Next steps:`);
  console.log(`  harbour agent run       # run one poll cycle now`);
  console.log(`  harbour agent install   # schedule polling via launchd (macOS)`);
}

export async function connectWorkflowRunner(blob) {
  if (!blob) {
    console.error("Usage: harbour workflow connect <base64-blob>");
    console.error("Copy the blob from the workflow runner setup response in harbour.");
    process.exit(1);
  }

  let config;
  try {
    config = decodeWorkflowBlob(blob);
  } catch (err) {
    console.error(`Blob decode failed: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `Connecting to ${config.url} as workflow runner "${config.name}" (${config.runnerId})...`,
  );

  try {
    await verifyWorkflowAuth(config.url, config.apiKey);
  } catch (err) {
    console.error(`Verification failed: ${err.message}`);
    process.exit(1);
  }

  const { file, replaced } = writeWorkflowRunner(config);
  console.log(
    `${replaced ? "Updated" : "Added"} workflow runner config for "${config.name}" in ${file}`,
  );
  console.log();
  console.log(`Next steps:`);
  console.log(`  harbour workflow run       # run one poll cycle now`);
  console.log(`  harbour workflow install   # schedule polling via launchd (macOS)`);
}
