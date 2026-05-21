#!/usr/bin/env node
import { readFileSync } from "fs";
import { evaluateHermesHookPayload } from "./lib/sage-guard.mjs";

async function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify({
      action: "block",
      message: "Sage blocked this action because Hermes supplied an invalid hook payload.",
    }));
    return;
  }

  const result = await evaluateHermesHookPayload(payload);
  if (!result.allowed) {
    process.stdout.write(JSON.stringify({
      action: "block",
      message: result.message,
    }));
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    action: "block",
    message: `Sage runtime security failed closed: ${error instanceof Error ? error.message : String(error)}`,
  }));
});
