import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import { deleteAgent, getAgentById, getAgentWorkspace, updateAgent } from "@/lib/db/queries";
import { loadRunners, removeRunnerConfig, saveRunnerConfig } from "@/lib/runners";

export const GET = withResourceAuth("agent", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const agent = getAgentById(id);
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    // Workspace slugs let the dashboard show the agent's on-disk runner path.
    return NextResponse.json({ ...agent, workspace: getAgentWorkspace(id) });
  },
);

export const PUT = withResourceAuth("agent", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const existing = getAgentById(id);
    if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    const body = await req.json();
    if (body.cli !== undefined) {
      const cliError = validateCli(body.cli);
      if (cliError) return NextResponse.json({ error: cliError }, { status: 400 });
    }
    if (body.cli !== undefined || body.thinking !== undefined) {
      // Validate the effective combination, not just the changed field — a cli
      // change alone must not strand a thinking level the new CLI rejects.
      const cli = body.cli !== undefined ? body.cli : existing.cli;
      const thinking = body.thinking !== undefined ? body.thinking : existing.thinking;
      const thinkingError = validateThinking(cli, thinking);
      if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });
    }
    const updated = updateAgent(id, body);

    // Sync runner config when any synced field changed.
    if (
      body.model !== undefined ||
      body.name !== undefined ||
      body.thinking !== undefined ||
      body.eager !== undefined
    ) {
      const runner = loadRunners().find((r) => r.agentId === id);
      if (runner) {
        if (body.model !== undefined) runner.model = body.model;
        if (body.name !== undefined) runner.name = body.name;
        if (body.thinking !== undefined) runner.thinking = body.thinking || null;
        if (body.eager !== undefined) runner.eager = !!body.eager;
        saveRunnerConfig(runner);
      }
    }

    return NextResponse.json(updated);
  },
);

export const DELETE = withResourceAuth("agent", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    deleteAgent(id);
    removeRunnerConfig(id);
    return NextResponse.json({ ok: true });
  },
);
