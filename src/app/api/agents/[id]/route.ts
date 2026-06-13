import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { validateCli, validateThinking } from "@/lib/cli-config";
import { deleteAgent, getAgentById, getAgentWorkspace, updateAgent } from "@/lib/db/queries";
import { optionalBoolean, optionalString, readJson } from "@/lib/http";
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

    const body = await readJson(req);
    // Type-guard each present field; absent fields stay untouched on update.
    const name = optionalString(body.name, "name");
    const description = optionalString(body.description, "description");
    const model = optionalString(body.model, "model");
    const color = optionalString(body.color, "color");
    const thinking = optionalString(body.thinking, "thinking");
    const eager = optionalBoolean(body.eager, "eager");
    // `remote` is accepted but not a stored agent field — validate it anyway so a
    // wrong-typed value is a clean 400 rather than silently ignored.
    optionalBoolean(body.remote, "remote");
    const cli = optionalString(body.cli, "cli");

    if (cli !== undefined) {
      const cliError = validateCli(cli);
      if (cliError) return NextResponse.json({ error: cliError }, { status: 400 });
    }
    if (cli !== undefined || thinking !== undefined) {
      // Validate the effective combination, not just the changed field — a cli
      // change alone must not strand a thinking level the new CLI rejects.
      const effectiveCli = cli !== undefined ? cli : existing.cli;
      const effectiveThinking = thinking !== undefined ? thinking : existing.thinking;
      const thinkingError = validateThinking(effectiveCli, effectiveThinking);
      if (thinkingError) return NextResponse.json({ error: thinkingError }, { status: 400 });
    }

    const updates = { name, description, cli, model, thinking, color, eager };
    const updated = updateAgent(id, updates);

    // Sync runner config when any synced field changed.
    if (
      model !== undefined ||
      name !== undefined ||
      thinking !== undefined ||
      eager !== undefined
    ) {
      const runner = loadRunners().find((r) => r.agentId === id);
      if (runner) {
        if (model !== undefined) runner.model = model;
        if (name !== undefined) runner.name = name;
        if (thinking !== undefined) runner.thinking = thinking || null;
        if (eager !== undefined) runner.eager = eager;
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
