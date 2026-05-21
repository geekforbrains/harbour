/**
 * Singleton process manager for Captain conversations.
 * Manages CLI child processes — one per active conversation.
 *
 * Uses globalThis to survive Next.js dev HMR reloads.
 */

import path from "path";
import { getProvider, runCliTool, type CliEvent } from "./providers";
import { setupWorkspace } from "./workspace";
import {
  addCaptainOutput,
  updateMessageContent,
  updateConversation,
  listCaptainOutput,
} from "../db/captain";
import { harbourHome, ensureDir } from "../paths";

type ActiveProcess = {
  conversationId: string;
  messageId: string;
  abortController: AbortController;
  done: Promise<void>;
};

type ProcessManager = {
  active: Map<string, ActiveProcess>;
};

const GLOBAL_KEY = "__harbour_captain_pm__";

function getManager(): ProcessManager {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { active: new Map() };
  }
  return g[GLOBAL_KEY];
}

export function isRunning(conversationId: string): boolean {
  return getManager().active.has(conversationId);
}

export function stop(conversationId: string): boolean {
  const mgr = getManager();
  const proc = mgr.active.get(conversationId);
  if (!proc) return false;
  proc.abortController.abort();
  return true;
}

export async function spawn(opts: {
  conversationId: string;
  messageId: string;
  prompt: string;
  cli: string;
  model: string | null;
  thinking: string | null;
  sessionId: string | null;
  isNewSession: boolean;
  cwd: string | null;
}): Promise<void> {
  const mgr = getManager();
  if (mgr.active.has(opts.conversationId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  const abortController = new AbortController();
  const provider = await getProvider(opts.cli);

  // Resolve working directory
  const defaultCwd = path.join(harbourHome(), "captain");
  const cwd = opts.cwd || defaultCwd;
  ensureDir(cwd);
  setupWorkspace(cwd);

  // Build CLI command
  const cmd = provider.buildCommand(
    opts.prompt,
    opts.model,
    cwd,
    opts.sessionId,
    opts.isNewSession,
    opts.thinking
  );

  // Create stateful parser
  const parser = provider.createParser
    ? provider.createParser()
    : null;

  let capturedSessionId = opts.sessionId;

  console.log(`[captain] Spawning ${cmd.binary} with args:`, cmd.args.slice(0, 5), `cwd: ${cmd.cwd}`);

  const done = (async () => {
    try {
      const cliResult = await runCliTool(cmd.binary, cmd.args, cmd.cwd, {
        timeoutMs: 30 * 60 * 1000, // 30 min max
        signal: abortController.signal,
        onLine: (line: string) => {
          let events: CliEvent[] = [];
          let sessionId: string | undefined;

          if (parser) {
            const parsed = parser.parseLine(line);
            events = parsed.events || [];
            sessionId = parsed.sessionId;
          } else {
            // Fallback for providers without createParser (codex/gemini use parseLine directly)
            const parsed = provider.parseLine(line);
            events = parsed.events || [];
            sessionId = parsed.sessionId;
          }

          if (sessionId) {
            capturedSessionId = sessionId;
          }

          if (events.length > 0) {
            addCaptainOutput(
              opts.conversationId,
              opts.messageId,
              events.map((e: CliEvent) => ({
                event_type: e.event_type,
                content: e.content ?? null,
                tool_name: e.tool_name ?? null,
              }))
            );
          }
        },
      });
      console.log(`[captain] CLI exited with code ${cliResult.code}, stderr: ${cliResult.stderr?.slice(0, 200)}`);
    } catch (err) {
      console.error(`[captain] Spawn error:`, err);
      // Process spawn error — write as error event
      addCaptainOutput(opts.conversationId, opts.messageId, [
        {
          event_type: "error",
          content:
            err instanceof Error ? err.message : "CLI process failed to start",
          tool_name: null,
        },
      ]);
    } finally {
      // Assemble final assistant message from text_delta events
      const allOutput = listCaptainOutput(opts.conversationId, 0).filter(
        (e) => e.message_id === opts.messageId
      );
      const fullText = allOutput
        .filter((e) => e.event_type === "text_delta")
        .map((e) => e.content || "")
        .join("");
      updateMessageContent(opts.messageId, fullText);

      // Persist session ID for resume
      if (capturedSessionId) {
        updateConversation(opts.conversationId, {
          session_id: capturedSessionId,
        });
      }

      mgr.active.delete(opts.conversationId);
    }
  })();

  mgr.active.set(opts.conversationId, {
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    abortController,
    done,
  });
}

/**
 * Get the message ID of the currently active response, if any.
 */
export function activeMessageId(conversationId: string): string | null {
  const proc = getManager().active.get(conversationId);
  return proc?.messageId ?? null;
}
