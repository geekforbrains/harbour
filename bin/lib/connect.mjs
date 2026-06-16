import { saveRunnerCredentials } from "./config.mjs";
import { detectCapabilities } from "./providers.mjs";

// A runner connect blob carries everything the runner needs to authenticate:
// where Harbour is, the runner's bearer token, and a friendly name. Minted by
// an operator over the API (POST /api/runners). The token is the only secret.
const REQUIRED_FIELDS = ["url", "token", "name"];

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

/**
 * Prove the token works by peeking the claim endpoint with this host's
 * capabilities. A 200 means the runner is registered and reachable; 401/403
 * means a bad/revoked token.
 */
async function verifyToken(url, token) {
  const endpoint = `${url.replace(/\/$/, "")}/api/runner/claim?peek=true`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: detectCapabilities() }),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${endpoint}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Authentication failed (HTTP ${res.status}) — the runner token is invalid`);
  }
  if (!res.ok) {
    throw new Error(`Server returned HTTP ${res.status} — expected 200 on peek`);
  }
}

export async function connectRunner(blob) {
  if (!blob) {
    console.error("Usage: harbour connect <base64-blob>");
    console.error("Paste the blob from a minted runner credential (POST /api/runners).");
    process.exit(1);
  }

  let config;
  try {
    config = decodeBlob(blob);
  } catch (err) {
    console.error(`Blob decode failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`Connecting to ${config.url} as runner "${config.name}"…`);
  try {
    await verifyToken(config.url, config.token);
  } catch (err) {
    console.error(`Verification failed: ${err.message}`);
    process.exit(1);
  }

  saveRunnerCredentials({ token: config.token, url: config.url });
  console.log(`Connected. Runner token saved (0600).`);
  console.log();
  console.log("Next steps:");
  console.log("  harbour run       # run one claim cycle now");
  console.log("  harbour install   # schedule polling as a service");
}
