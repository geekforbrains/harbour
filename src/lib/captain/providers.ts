/**
 * Thin wrapper around bin/lib/providers.mjs for use in the Next.js server.
 * Uses dynamic import() to load the ESM module at runtime.
 */

import path from "path";

let _providers: any = null;

async function getProviders() {
  if (!_providers) {
    // Resolve from project root — works regardless of bundler output location
    const providersPath = path.join(process.cwd(), "bin", "lib", "providers.mjs");
    _providers = await import(/* webpackIgnore: true */ providersPath);
  }
  return _providers;
}

export type CliEvent = {
  event_type: string;
  content: string | null;
  tool_name?: string | null;
};

export type RunCliToolResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
};

export type RunCliToolOptions = {
  timeoutMs?: number;
  startupTimeoutMs?: number;
  killGraceMs?: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
};

export async function getProvider(cli: string) {
  const providers = await getProviders();
  return providers.getProvider(cli);
}

export async function runCliTool(
  binary: string,
  args: string[],
  cwd: string,
  options?: RunCliToolOptions
): Promise<RunCliToolResult> {
  const providers = await getProviders();
  return providers.runCliTool(binary, args, cwd, options);
}
