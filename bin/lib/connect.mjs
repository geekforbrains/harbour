import fs from "fs";
import path from "path";
import { ensureDir, getHarbourDir, loadRunnerConfigs } from "./config.mjs";

const REQUIRED_FIELDS = ["url", "agentId", "apiKey", "cli", "name"];

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

async function verifyAuth(url, agentId, apiKey) {
  const endpoint = `${url.replace(/\/$/, "")}/api/agents/${agentId}/next?peek=true`;
  let res;
  try {
    res = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new Error(`Cannot reach ${endpoint}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Authentication failed (HTTP ${res.status}) — the API key is invalid or doesn't match this agent`);
  }
  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status} — expected 200 on peek`);
  }
}

function writeRunner(config) {
  ensureDir();
  const runners = loadRunnerConfigs();
  const existing = runners.findIndex(r => r.agentId === config.agentId);
  const entry = {
    agentId: config.agentId,
    name: config.name,
    apiKey: config.apiKey,
    cli: config.cli,
    model: config.model ?? null,
    thinking: config.thinking ?? null,
    eager: !!config.eager,
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
