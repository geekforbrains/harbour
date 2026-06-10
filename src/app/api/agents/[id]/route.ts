import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { deleteAgent, getAgentById, updateAgent } from "@/lib/db/queries";
import { loadRunners, removeRunnerConfig, saveRunnerConfig } from "@/lib/runners";

export const GET = withResourceAuth("agent", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const agent = getAgentById(id);
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    return NextResponse.json(agent);
  },
);

export const PUT = withResourceAuth("agent", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const existing = getAgentById(id);
    if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    const body = await req.json();
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
