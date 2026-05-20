import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getDb } from "@/lib/db/schema";
import { getSetting } from "@/lib/db/settings";
import os from "os";

type CountRow = { n: number };

function getRunCounts() {
  const db = getDb();
  const running = (db.prepare("SELECT COUNT(*) as n FROM runs WHERE status = 'running'").get() as CountRow | undefined)?.n ?? 0;
  const pending = (db.prepare("SELECT COUNT(*) as n FROM runs WHERE status = 'pending'").get() as CountRow | undefined)?.n ?? 0;
  const done24h = (db.prepare(
    "SELECT COUNT(*) as n FROM runs WHERE status = 'done' AND completed_at > unixepoch() - 86400"
  ).get() as CountRow | undefined)?.n ?? 0;
  const failed24h = (db.prepare(
    "SELECT COUNT(*) as n FROM runs WHERE status = 'failed' AND completed_at > unixepoch() - 86400"
  ).get() as CountRow | undefined)?.n ?? 0;
  return { running, pending, done24h, failed24h };
}

function getAgentCount() {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as n FROM agents").get() as CountRow | undefined)?.n ?? 0;
}

function getJobCount() {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as n FROM jobs WHERE active = 1").get() as CountRow | undefined)?.n ?? 0;
}

function getSystemMetrics() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 100);

  // CPU load: 1-minute load average as percentage of logical cores
  const loadAvg = os.loadavg()[0];
  const cpuPct = Math.min(100, Math.round((loadAvg / cpus.length) * 100));

  return {
    cpuPct,
    cpuCores: cpus.length,
    loadAvg1m: parseFloat(loadAvg.toFixed(2)),
    memUsedMb: Math.round(usedMem / 1024 / 1024),
    memTotalMb: Math.round(totalMem / 1024 / 1024),
    memPct,
    uptimeHours: parseFloat((os.uptime() / 3600).toFixed(1)),
    platform: os.platform(),
  };
}

async function getFreeLLMStatus(baseUrl: string, apiKey: string) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { online: false, modelCount: 0 };
    const data = await res.json() as { data?: unknown[] };
    return { online: true, modelCount: data.data?.length ?? 0 };
  } catch {
    return { online: false, modelCount: 0 };
  }
}

export const GET = withAuth(async () => {
  const runs = getRunCounts();
  const system = getSystemMetrics();

  const freellmEnabled = getSetting("freellm_enabled") === "true";
  const freellmBase = getSetting("freellm_base_url") || "http://localhost:3011/v1";
  const freellmKey = getSetting("freellm_api_key") || "";
  const freellm = freellmEnabled
    ? await getFreeLLMStatus(freellmBase, freellmKey)
    : { online: false, modelCount: 0 };

  return NextResponse.json({
    timestamp: Date.now(),
    runs,
    agents: getAgentCount(),
    jobs: getJobCount(),
    system,
    freellm: {
      enabled: freellmEnabled,
      baseUrl: freellmBase,
      ...freellm,
    },
  });
});
