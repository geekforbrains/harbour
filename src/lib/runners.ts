import fs from "fs";
import { runnersFile, harbourHome, ensureDir } from "./paths";

// Runner config is identity-only: which agent, its key, and where harbour is.
// The agent's cli/model/thinking/eager are resolved live from the /next payload
// (see buildRunPayload), so they aren't stored here. cli/model/thinking stay
// optional for backward compat with configs written by older versions.
export type RunnerConfig = {
  agentId: string;
  name: string;
  apiKey: string;
  url: string;
  cli?: string;
  model?: string | null;
  thinking?: string | null;
  eager?: boolean;
};

export function loadRunners(): RunnerConfig[] {
  const file = runnersFile();
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8")).runners || [];
}

function saveRunners(runners: RunnerConfig[]) {
  ensureDir(harbourHome());
  fs.writeFileSync(runnersFile(), JSON.stringify({ runners }, null, 2));
}

export function saveRunnerConfig(config: RunnerConfig) {
  const runners = loadRunners();
  const existing = runners.findIndex(r => r.agentId === config.agentId);
  if (existing >= 0) {
    runners[existing] = config;
  } else {
    runners.push(config);
  }
  saveRunners(runners);
}

export function removeRunnerConfig(agentId: string) {
  const runners = loadRunners().filter(r => r.agentId !== agentId);
  saveRunners(runners);
}
