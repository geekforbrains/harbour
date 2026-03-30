import { loadRunnerConfigs, loadSessions, saveSessions } from "./config.mjs";
import { getProvider, ensureWorkingDir, runCliTool } from "./providers.mjs";

async function apiCall(url, apiKey, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function buildPrompt(payload, isResume) {
  if (isResume) {
    // On resume, the CLI session already has the prior context.
    // Just pass the new human messages since the last agent message.
    const activity = payload.run.activity || [];
    const lastAgentIdx = activity.findLastIndex(a => a.author_type === "agent");
    const newMessages = lastAgentIdx >= 0 ? activity.slice(lastAgentIdx + 1) : activity;
    const humanMessages = newMessages
      .filter(a => a.author_type === "user" || a.author_type === "system")
      .map(a => `[${a.author_type}] ${a.content}`)
      .join("\n\n");

    return `The human has responded to your previous work. Here is their message:\n\n${humanMessages}\n\nContinue working on this task based on their response. If you need further human input, include [WAITING] in your response again. When you are done, provide a summary of what you did.`;
  }

  // New run: build full context prompt
  let prompt = "";

  if (payload.job?.name) {
    prompt += `# Job: ${payload.job.name}\n\n`;
  }
  if (payload.job?.instructions) {
    prompt += `## Instructions\n\n${payload.job.instructions}\n\n`;
  }

  // Include docs
  if (payload.docs?.length > 0) {
    prompt += `## Reference Documents\n\n`;
    for (const doc of payload.docs) {
      prompt += `### ${doc.title}\n\n${doc.content || "(empty)"}\n\n`;
    }
  }

  // Include database data
  if (payload.data && Object.keys(payload.data).length > 0) {
    prompt += `## Reference Data\n\n`;
    for (const [name, rows] of Object.entries(payload.data)) {
      prompt += `### ${name}\n\n`;
      if (rows.length > 0) {
        prompt += `\`\`\`json\n${JSON.stringify(rows.slice(0, 20), null, 2)}\n\`\`\`\n\n`;
      } else {
        prompt += `(no rows)\n\n`;
      }
    }
  }

  // Include prior activity if any
  const activity = payload.run.activity || [];
  if (activity.length > 0) {
    prompt += `## Activity Log\n\n`;
    for (const a of activity) {
      prompt += `[${a.author_type}] ${a.content}\n\n`;
    }
  }

  // Pre-run check
  if (payload.job?.check) {
    prompt += `## Pre-run Check\n\nBefore starting, run this command: \`${payload.job.check}\`\nIf it returns non-zero, skip this run by setting status to "skipped".\n\n`;
  }

  prompt += `\n## Important\n\n`;
  prompt += `When you are done, provide a summary of what you did.\n`;
  prompt += `If you need human input before you can continue, include the marker [WAITING] in your response `;
  prompt += `and clearly explain what you need and why. `;
  prompt += `The run will be paused and a human will respond on the dashboard. `;
  prompt += `You will then be resumed with their response.\n`;

  return prompt;
}

async function runSingleAgent(runner) {
  const { agentId, apiKey, cli, model, name: agentName, url } = runner;
  const provider = getProvider(cli);
  const sessions = loadSessions();

  console.log(`  [${agentName}] Polling...`);

  // Poll for next run
  let payload;
  try {
    payload = await apiCall(`${url}/api/agents/${agentId}/next`, apiKey);
  } catch (err) {
    console.error(`  [${agentName}] Poll failed: ${err.message}`);
    return;
  }

  if (!payload || !payload.run) {
    console.log(`  [${agentName}] Nothing to do.`);
    return;
  }

  const runId = payload.run.id;
  const existingSession = sessions[runId];
  const isResume = !!existingSession;
  let sessionId = existingSession?.sessionId || null;
  const isNewSession = !isResume;

  // For Claude, generate a session ID upfront so we can always resume
  if (isNewSession && provider.generateSessionId) {
    sessionId = provider.generateSessionId();
  }

  console.log(`  [${agentName}] ${isResume ? "Resuming" : "Starting"} run ${runId} (${payload.job?.name || "one-off"})`);

  // Build prompt
  const prompt = buildPrompt(payload, isResume);

  // Build CLI command
  const workingDir = ensureWorkingDir(agentName);
  const cmd = provider.buildCommand(prompt, model, workingDir, sessionId, isNewSession);

  // Execute CLI tool
  let result;
  try {
    result = await runCliTool(cmd.binary, cmd.args, cmd.cwd);
  } catch (err) {
    console.error(`  [${agentName}] CLI execution failed: ${err.message}`);
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Runner error: CLI tool "${cli}" failed to execute: ${err.message}`,
      });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }
    return;
  }

  // Parse result — for Claude, pass the pre-generated sessionId
  const parsed = provider.parseResult(result.stdout, sessionId);
  const output = parsed.content || result.stdout || result.stderr || "(no output)";
  const newSessionId = parsed.sessionId || sessionId;

  // Check if CLI exited with error
  if (result.code !== 0) {
    console.error(`  [${agentName}] CLI exited with code ${result.code}`);
    const errorContent = output.length > 4000 ? output.slice(-4000) : output;
    try {
      await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
        content: `Agent encountered an error (exit code ${result.code}):\n\n${errorContent}`,
      });
      await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status: "failed" });
    } catch { /* best effort */ }

    // Clean up session on failure
    delete sessions[runId];
    saveSessions(sessions);
    return;
  }

  // Post output as activity
  const truncatedOutput = output.length > 50000 ? output.slice(-50000) : output;
  try {
    await apiCall(`${url}/api/runs/${runId}/activity`, apiKey, "POST", {
      content: truncatedOutput,
    });
  } catch (err) {
    console.error(`  [${agentName}] Failed to post activity: ${err.message}`);
  }

  // Detect waiting marker: if agent output contains [WAITING], pause for human input
  const isWaiting = /\[WAITING\]/i.test(output);
  const status = isWaiting ? "waiting" : "done";

  try {
    await apiCall(`${url}/api/runs/${runId}/status`, apiKey, "PUT", { status });
  } catch (err) {
    console.error(`  [${agentName}] Failed to update status: ${err.message}`);
  }

  if (isWaiting) {
    // Preserve the CLI session so we can resume when the human responds
    sessions[runId] = { sessionId: newSessionId, cli };
    saveSessions(sessions);
    console.log(`  [${agentName}] Run ${runId} waiting for human input (session preserved)`);
  } else {
    // Clean up session on completion
    delete sessions[runId];
    saveSessions(sessions);
    console.log(`  [${agentName}] Run ${runId} completed with status: ${status}`);
  }
}

export async function runAgents() {
  const runners = loadRunnerConfigs();
  if (runners.length === 0) {
    console.log("No harbour agents configured. Create one from the dashboard.");
    return;
  }

  console.log(`Polling ${runners.length} harbour agent(s)...`);

  // Poll all agents first (fast), collect work
  const work = [];
  for (const runner of runners) {
    work.push(runSingleAgent(runner));
  }

  // Run all in parallel
  await Promise.allSettled(work);

  console.log("Done.");
}
