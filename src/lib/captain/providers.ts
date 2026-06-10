/**
 * Thin wrapper around bin/lib/providers.mjs for use in the Next.js server.
 * Uses dynamic import() to load the ESM module at runtime.
 */

import path from "node:path";

let _providers: ProvidersModule | null = null;

async function getProviders(): Promise<ProvidersModule> {
  if (!_providers) {
    // Resolve from project root — works regardless of bundler output location
    const providersPath = path.join(process.cwd(), "bin", "lib", "providers.mjs");
    _providers = (await import(/* webpackIgnore: true */ providersPath)) as ProvidersModule;
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

export type ParsedCliLine = { events?: CliEvent[]; sessionId?: string };

export type CliCommand = { binary: string; args: string[]; cwd: string };

// Shape of a provider object from bin/lib/providers.mjs (untyped ESM).
export type CliProvider = {
  buildCommand: (
    prompt: string,
    model: string | null,
    cwd: string,
    sessionId: string | null,
    isNewSession: boolean,
    thinking: string | null,
  ) => CliCommand;
  createParser?: () => { parseLine: (line: string) => ParsedCliLine };
  parseLine: (line: string) => ParsedCliLine;
  canResume?: boolean;
};

type ProvidersModule = {
  getProvider: (cli: string) => CliProvider;
  runCliTool: (
    binary: string,
    args: string[],
    cwd: string,
    options?: RunCliToolOptions,
  ) => Promise<RunCliToolResult>;
};

export async function getProvider(cli: string): Promise<CliProvider> {
  const providers = await getProviders();
  return providers.getProvider(cli);
}

export async function runCliTool(
  binary: string,
  args: string[],
  cwd: string,
  options?: RunCliToolOptions,
): Promise<RunCliToolResult> {
  const providers = await getProviders();
  return providers.runCliTool(binary, args, cwd, options);
}
