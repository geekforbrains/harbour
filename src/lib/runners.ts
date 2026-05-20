import fs from "fs";
import { runnersFile, harbourHome, ensureDir } from "./paths";

export type RunnerConfig = {
  agentId: string;
  name: string;
  apiKey: string;
  cli: string;
  model: string | null;
  thinking: string | null;
  eager?: boolean;
  url: string;
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
