import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { execSync } from "child_process";
import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";

const CLI_TOOLS = [
  { id: "claude",   name: "Claude",   binary: "claude",   versionFlag: "--version" },
  { id: "codex",    name: "Codex",    binary: "codex",    versionFlag: "--version" },
  { id: "gemini",   name: "Gemini",   binary: "gemini",   versionFlag: "--version" },
  { id: "pi",       name: "Pi",       binary: "pi",       versionFlag: "--version" },
  { id: "opencode", name: "OpenCode", binary: "opencode", versionFlag: "--version" },
  { id: "openclaw", name: "OpenClaw", binary: "openclaw", versionFlag: "--version" },
  { id: "hermes",   name: "Hermes",   binary: "hermes",   versionFlag: "--version" },
];

// Extend PATH with common user binary locations that may not be in the server's PATH.
// Include nvm active-version bin so pi/opencode (installed via npm -g) resolve correctly.
function nvmBinPaths(): string[] {
  try {
    const nvmDir = process.env.NVM_DIR || path.join(homedir(), ".nvm");
    const versions = readdirSync(path.join(nvmDir, "versions", "node"))
      .sort()
      .reverse(); // newest first
    return versions.map(v => path.join(nvmDir, "versions", "node", v, "bin"));
  } catch {
    return [];
  }
}

const EXTRA_PATHS = [
  path.join(homedir(), ".local", "bin"),
  path.join(homedir(), ".npm-global", "bin"),
  path.join(homedir(), ".composio"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  ...nvmBinPaths(),
];

const extendedPath = [...EXTRA_PATHS, process.env.PATH].join(":");

function checkTool(tool: typeof CLI_TOOLS[number]) {
  try {
    const whichResult = execSync(`which ${tool.binary} 2>/dev/null`, { encoding: "utf-8", env: { ...process.env, PATH: extendedPath } }).trim();
    if (!whichResult) return { id: tool.id, name: tool.name, installed: false };

    let version = null;
    try {
      version = execSync(`${tool.binary} ${tool.versionFlag} 2>/dev/null`, { encoding: "utf-8", timeout: 5000, env: { ...process.env, PATH: extendedPath } }).trim();
      // Extract just the version number if there's extra text
      const match = version.match(/[\d]+\.[\d]+[\d.]*/);
      if (match) version = match[0];
    } catch { /* version check failed, binary still exists */ }

    return { id: tool.id, name: tool.name, installed: true, version, path: whichResult };
  } catch {
    return { id: tool.id, name: tool.name, installed: false };
  }
}

export const GET = withAuth(async () => {
  const tools = CLI_TOOLS.map(checkTool);
  const composio = checkTool({ id: "composio", name: "Composio", binary: "composio", versionFlag: "--version" });
  return NextResponse.json(tools.map(tool => ({ ...tool, composio })));
});
