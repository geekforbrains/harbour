import { execSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";

export const CLI_TOOLS = [
  { id: "claude", name: "Claude", binary: "claude", versionFlag: "--version" },
  { id: "codex", name: "Codex", binary: "codex", versionFlag: "--version" },
];

// Extend PATH with common user binary locations that may not be in the server's PATH
const EXTRA_PATHS = [
  path.join(homedir(), ".local", "bin"),
  path.join(homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

const extendedPath = [...EXTRA_PATHS, process.env.PATH].join(":");

function checkTool(tool: (typeof CLI_TOOLS)[number]) {
  try {
    const whichResult = execSync(`which ${tool.binary} 2>/dev/null`, {
      encoding: "utf-8",
      env: { ...process.env, PATH: extendedPath },
    }).trim();
    if (!whichResult) return { id: tool.id, name: tool.name, installed: false };

    let version = null;
    try {
      version = execSync(`${tool.binary} ${tool.versionFlag} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, PATH: extendedPath },
      }).trim();
      // Extract just the version number if there's extra text
      const match = version.match(/[\d]+\.[\d]+[\d.]*/);
      if (match) version = match[0];
    } catch {
      /* version check failed, binary still exists */
    }

    return {
      id: tool.id,
      name: tool.name,
      installed: true,
      version,
      path: whichResult,
    };
  } catch {
    return { id: tool.id, name: tool.name, installed: false };
  }
}

export const GET = withAuthenticatedUser(async () => {
  const tools = CLI_TOOLS.map(checkTool);
  return NextResponse.json(tools);
});
