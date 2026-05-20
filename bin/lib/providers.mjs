import { spawn, execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

// Cache resolved binary paths
const binaryPathCache = {};
function resolveBinary(name) {
  if (!binaryPathCache[name]) {
    try {
      binaryPathCache[name] = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    } catch {
      binaryPathCache[name] = name; // fallback to bare name
    }
  }
  return binaryPathCache[name];
}

// Normalized event types emitted by all providers:
//   text_delta   — streaming text content
//   tool_start   — agent started using a tool
//   tool_end     — tool execution finished (with output)
//   thinking     — model thinking/reasoning
//   info         — system info (init, model, etc.)
//   error        — error message
//   result       — final summary

// Extract a concise display string from a tool's input JSON.
function formatToolInput(toolName, inputJson) {
  if (!inputJson) return null;
  try {
    const input = JSON.parse(inputJson);
    switch (toolName) {
      case "Bash": return input.command || null;
      case "Read": return input.file_path || null;
      case "Write": return input.file_path || null;
      case "Edit": return input.file_path || null;
      case "Grep": return input.pattern || null;
      case "Glob": return input.pattern || null;
      case "Agent": return input.description || null;
      case "WebSearch": return input.query || null;
      case "WebFetch": return input.url || null;
      default: {
        const str = JSON.stringify(input);
        return str.length > 200 ? str.slice(0, 200) + "..." : str;
      }
    }
  } catch {
    return null;
  }
}

// Provider: how to invoke each CLI tool in batch mode, with streaming support

const PROVIDERS = {
  claude: {
    generateSessionId() {
      return crypto.randomUUID();
    },
    buildCommand(prompt, model, workingDir, sessionId, isNewSession, thinking) {
      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];
      // If the workspace has a valid .claude/settings.json with a permissions
      // object, opt into the permission system. Otherwise, fall back to the
      // legacy unrestricted mode so existing agents keep working without
      // per-agent config.
      //
      // Validate by stat (regular file, not a symlink to /dev/null) and JSON
      // parse with a permissions object — a corrupt or empty settings file
      // shouldn't silently switch the agent into a less-protected mode.
      let hasSettings = false;
      try {
        const settingsPath = path.join(workingDir, ".claude", "settings.json");
        const st = fs.statSync(settingsPath);
        if (st.isFile() && st.size > 0) {
          const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
          if (parsed && typeof parsed.permissions === "object") {
            hasSettings = true;
          }
        }
      } catch {
        // Missing file, parse error, etc. — fall through to legacy mode.
      }
      if (!hasSettings) {
        args.push("--dangerously-skip-permissions");
      }
      if (model) args.push("--model", model);
      if (thinking) args.push("--effort", thinking);
      if (isNewSession && sessionId) {
        args.push("--session-id", sessionId);
      } else if (sessionId) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { binary: resolveBinary("claude"), args, cwd: workingDir };
    },
    // Returns a stateful parser that accumulates tool input from streaming
    // deltas before emitting tool_start with the full input content.
    createParser() {
      // Track in-flight tool_use blocks: index → { toolName, inputJson }
      const activeBlocks = new Map();
      // The Anthropic stream protocol emits no separator between distinct text
      // content blocks (common when text is interleaved with tool_use). Naive
      // concatenation produces "first sentence.second sentence." — inject a
      // paragraph break at the start of each new text block after the first.
      let hasEmittedText = false;
      let needsLeadingBreak = false;

      return {
        parseLine(line) {
          try {
            const obj = JSON.parse(line);
            const events = [];

            if (obj.type === "system" && obj.subtype === "init") {
              events.push({ event_type: "info", content: `Model: ${obj.model}` });
              return { events, sessionId: obj.session_id };
            }

            if (obj.type === "stream_event" && obj.event) {
              const evt = obj.event;
              if (evt.type === "content_block_delta") {
                if (evt.delta?.type === "text_delta" && evt.delta.text) {
                  let text = evt.delta.text;
                  if (needsLeadingBreak) {
                    text = "\n\n" + text;
                    needsLeadingBreak = false;
                  }
                  events.push({ event_type: "text_delta", content: text });
                  hasEmittedText = true;
                }
                if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
                  events.push({ event_type: "thinking", content: evt.delta.thinking });
                }
                // Accumulate tool input JSON fragments
                if (evt.delta?.type === "input_json_delta" && evt.delta.partial_json != null) {
                  const block = activeBlocks.get(evt.index);
                  if (block) block.inputJson += evt.delta.partial_json;
                }
              }
              // Register tool block — defer tool_start until input is assembled
              if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                activeBlocks.set(evt.index, {
                  toolName: evt.content_block.name,
                  inputJson: "",
                });
              }
              // New text block after we've already emitted text → mark a paragraph break
              if (evt.type === "content_block_start" && evt.content_block?.type === "text") {
                if (hasEmittedText) needsLeadingBreak = true;
              }
              // Input fully assembled — emit tool_start with content
              if (evt.type === "content_block_stop") {
                const block = activeBlocks.get(evt.index);
                if (block) {
                  activeBlocks.delete(evt.index);
                  events.push({
                    event_type: "tool_start",
                    content: formatToolInput(block.toolName, block.inputJson),
                    tool_name: block.toolName,
                  });
                }
              }
            }

            // Tool result comes as an assistant message with tool_result content
            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "tool_result") {
                  events.push({
                    event_type: "tool_end",
                    content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                    tool_name: null,
                  });
                }
              }
            }

            if (obj.type === "result") {
              events.push({
                event_type: "result",
                content: obj.result || null,
              });
              return { events, sessionId: obj.session_id };
            }

            return { events };
          } catch {
            return { events: [] };
          }
        },
      };
    },
    parseResult(stdout, presetSessionId) {
      // Fallback full-parse for final content extraction
      const lines = stdout.trim().split("\n");
      let content = "";
      let sessionId = presetSessionId;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "result" && obj.result) {
            content = obj.result;
          }
          if (obj.session_id) sessionId = obj.session_id;
        } catch { /* skip */ }
      }
      if (!content) content = stdout;
      return { content: content.trim(), sessionId };
    },
  },

  codex: {
    buildCommand(prompt, model, workingDir, sessionId, _isNewSession, thinking) {
      // Codex 0.128+ removed the top-level --reasoning-effort flag. Use the
      // generic config override instead: -c model_reasoning_effort=<level>.
      if (sessionId) {
        const args = ["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "--json"];
        if (model) args.push("-m", model);
        if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
        args.push(sessionId, prompt);
        return { binary: resolveBinary("codex"), args, cwd: workingDir };
      }
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json"];
      if (model) args.push("-m", model);
      if (thinking) args.push("-c", `model_reasoning_effort=${thinking}`);
      args.push(prompt);
      return { binary: resolveBinary("codex"), args, cwd: workingDir };
    },
    parseLine(line) {
      try {
        const obj = JSON.parse(line);
        const events = [];

        if (obj.type === "thread.started" && obj.thread_id) {
          events.push({ event_type: "info", content: `Thread: ${obj.thread_id}` });
          return { events, sessionId: obj.thread_id };
        }

        if (obj.type === "item.started" && obj.item) {
          if (obj.item.type === "command_execution") {
            events.push({
              event_type: "tool_start",
              content: obj.item.command || null,
              tool_name: "shell",
            });
          }
        }

        if (obj.type === "item.completed" && obj.item) {
          if (obj.item.type === "agent_message" && obj.item.text) {
            events.push({ event_type: "text_delta", content: obj.item.text });
          }
          if (obj.item.type === "command_execution") {
            events.push({
              event_type: "tool_end",
              content: obj.item.aggregated_output != null && obj.item.aggregated_output !== ""
                ? obj.item.aggregated_output
                : `exit ${obj.item.exit_code}`,
              tool_name: "shell",
            });
          }
        }

        if (obj.type === "turn.completed") {
          events.push({
            event_type: "result",
            content: obj.usage ? `Tokens: ${obj.usage.input_tokens} in / ${obj.usage.output_tokens} out` : null,
          });
        }

        return { events };
      } catch {
        return { events: [] };
      }
    },
    // Only use the last assistant message as the activity summary. Codex emits
    // multiple agent_message items during a run (narration before each tool call,
    // then a final summary). Concatenating all of them produces a verbose dump;
    // the last message is the natural summary of what was done.
    parseResult(stdout) {
      const lines = stdout.trim().split("\n");
      let sessionId = null;
      let lastMessage = "";

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "thread.started" && obj.thread_id) {
            sessionId = obj.thread_id;
          }
          if (obj.type === "item.completed" && obj.item) {
            if (obj.item.text) {
              lastMessage = obj.item.text;
            } else if (obj.item.content) {
              let text = "";
              for (const c of obj.item.content) {
                if (c.type === "output_text" || c.type === "text") {
                  text += (c.text || "") + "\n";
                }
              }
              if (text.trim()) lastMessage = text.trim();
            }
          }
          if (obj.type === "message.completed" && obj.message) {
            if (obj.message.text) {
              lastMessage = obj.message.text;
            } else if (obj.message.content) {
              let text = "";
              for (const c of obj.message.content) {
                if (c.type === "output_text" || c.type === "text") {
                  text += (c.text || "") + "\n";
                }
              }
              if (text.trim()) lastMessage = text.trim();
            }
          }
        } catch { /* Not JSON line */ }
      }

      if (!lastMessage.trim()) lastMessage = stdout;
      return { content: lastMessage.trim(), sessionId };
    },
  },

  gemini: {
    buildCommand(prompt, model, workingDir, sessionId, _isNewSession, _thinking) {
      // Gemini 0.40+ removed --thinking (reasoning depth is now controlled
      // by model selection) and requires --skip-trust for headless mode in
      // non-trusted workspace dirs (otherwise exits code 55).
      const args = ["--prompt", prompt, "--yolo", "--skip-trust", "-o", "stream-json"];
      if (model) args.push("-m", model);
      if (sessionId) {
        args.push("--resume", sessionId);
      }
      return { binary: resolveBinary("gemini"), args, cwd: workingDir };
    },
    parseLine(line) {
      try {
        const obj = JSON.parse(line);
        const events = [];

        if (obj.type === "init" && obj.session_id) {
          events.push({ event_type: "info", content: `Model: ${obj.model}` });
          return { events, sessionId: obj.session_id };
        }

        if (obj.type === "message" && obj.role === "assistant" && obj.content) {
          events.push({ event_type: "text_delta", content: obj.content });
        }

        if (obj.type === "tool_use") {
          events.push({
            event_type: "tool_start",
            content: obj.parameters ? JSON.stringify(obj.parameters) : null,
            tool_name: obj.tool_name || null,
          });
        }

        if (obj.type === "tool_result") {
          events.push({
            event_type: "tool_end",
            content: obj.output || null,
            tool_name: null,
          });
        }

        if (obj.type === "result") {
          const stats = obj.stats;
          events.push({
            event_type: "result",
            content: stats ? `Tokens: ${stats.input_tokens} in / ${stats.output_tokens} out, ${stats.duration_ms}ms` : null,
          });
        }

        return { events };
      } catch {
        return { events: [] };
      }
    },
    // Only use the last assistant turn as the activity summary. Gemini streams
    // multiple assistant message deltas across turns — early ones are narration
    // before tool calls, the final turn is the actual summary. We reset on
    // tool_result boundaries so we capture only the post-tool response.
    parseResult(stdout) {
      const lines = stdout.trim().split("\n");
      let sessionId = null;
      let content = "";

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "init" && obj.session_id) {
            sessionId = obj.session_id;
          }
          if (obj.type === "tool_result") {
            content = ""; // reset — next assistant messages are the final turn
          }
          if (obj.type === "message" && obj.role === "assistant" && obj.content) {
            content += obj.content;
          }
        } catch { /* Not JSON — skip stderr noise */ }
      }

      if (!content.trim()) content = stdout;
      return { content: content.trim(), sessionId };
    },
  },
};

export function getProvider(cli) {
  const provider = PROVIDERS[cli];
  if (!provider) throw new Error(`Unknown CLI provider: ${cli}`);
  return provider;
}

export function ensureWorkingDir(agentName) {
  const home = process.env.HARBOUR_HOME || path.join(os.homedir(), ".harbour");
  const dir = path.join(home, "workspaces", agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Run a CLI tool, streaming JSONL output line-by-line to onLine callback.
 * Returns { code, stdout, stderr, aborted } when the process exits.
 *
 * Pass `signal` (an AbortSignal) to request a graceful kill: SIGTERM is sent
 * immediately, followed by SIGKILL after `killGraceMs` (default 3s) if the
 * process hasn't exited.
 */
export function runCliTool(binary, args, cwd, { timeoutMs = 10 * 60 * 1000, startupTimeoutMs = 30_000, killGraceMs = 3000, onLine, signal, extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    // Build clean environment: strip Claude Code nesting guards, then layer
    // run-scoped env vars (decrypted Harbour env vars for this job) on top.
    // Putting them in the actual process env (not just the prompt) lets the
    // agent's shell expand `$VARNAME` naturally — needed for `curl -H
    // "Authorization: Bearer $TOKEN"` and similar patterns.
    const env = { ...process.env, ...(extraEnv || {}) };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION;
    delete env.CLAUDE_CODE_PARENT_SESSION;
    // If the workspace has a `bin/` directory, prepend it to PATH so per-agent
    // wrapper scripts (e.g. auth-curl shims) resolve as bare command names.
    try {
      const workspaceBin = path.join(cwd, "bin");
      if (fs.statSync(workspaceBin).isDirectory()) {
        env.PATH = `${workspaceBin}:${env.PATH || ""}`;
      }
    } catch { /* no workspace bin/, ignore */ }

    const child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: timeoutMs,
    });

    // Close stdin immediately — CLI tools should not wait for interactive input
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let gotOutput = false;
    let aborted = false;
    let killFollowupTimer = null;
    let closeFired = false;
    let postExitTimer = null;
    // If the CLI spawns grandchildren that inherit our stdout/stderr pipes
    // (docker compose, dev servers, simulators), "close" won't fire until
    // those descendants release the fds — which can be never. After the
    // process itself exits, give pipes a brief grace to drain, then
    // destroy them so the wrapper can resolve.
    const POST_EXIT_GRACE_MS = 2000;

    // Kill the process if no stdout arrives within the startup window.
    // Catches auth prompts, interactive login hangs, etc.
    const startupTimer = setTimeout(() => {
      if (!gotOutput) {
        child.kill("SIGTERM");
        // Give it a moment to exit, then force kill
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      }
    }, startupTimeoutMs);

    // Abort handler: SIGTERM → killGraceMs grace → SIGKILL
    function handleAbort() {
      if (aborted) return;
      aborted = true;
      try { child.kill("SIGTERM"); } catch {}
      killFollowupTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, killGraceMs);
    }
    if (signal) {
      if (signal.aborted) handleAbort();
      else signal.addEventListener("abort", handleAbort, { once: true });
    }

    child.stdout.on("data", (data) => {
      if (!gotOutput) {
        gotOutput = true;
        clearTimeout(startupTimer);
      }
      const chunk = data.toString();
      stdout += chunk;

      if (onLine) {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
    });

    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("error", (err) => {
      clearTimeout(startupTimer);
      if (killFollowupTimer) clearTimeout(killFollowupTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
      reject(err);
    });
    child.on("exit", () => {
      postExitTimer = setTimeout(() => {
        if (closeFired) return;
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
      }, POST_EXIT_GRACE_MS);
    });
    child.on("close", (code) => {
      closeFired = true;
      clearTimeout(startupTimer);
      if (killFollowupTimer) clearTimeout(killFollowupTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
      // Flush remaining buffer
      if (onLine && lineBuffer.trim()) {
        onLine(lineBuffer.trim());
      }
      resolve({ code, stdout, stderr, aborted });
    });
  });
}
