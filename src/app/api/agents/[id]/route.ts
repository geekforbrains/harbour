import { NextResponse } from "next/server";
import { withAuth, withUserAuth } from "@/lib/auth";
import { getAgentById, updateAgent, deleteAgent } from "@/lib/db/queries";
import { removeRunnerConfig, loadRunners, saveRunnerConfig } from "@/lib/runners";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
});

export const PUT = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const existing = getAgentById(id);
  if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await req.json();
  const updated = updateAgent(id, body);

  // Sync runner config if this is a harbour agent and any synced field changed
  if (existing.type === "harbour" && (body.model !== undefined || body.name !== undefined || body.thinking !== undefined || body.eager !== undefined)) {
    const runner = loadRunners().find(r => r.agentId === id);
    if (runner) {
      if (body.model !== undefined) runner.model = body.model;
      if (body.name !== undefined) runner.name = body.name;
      if (body.thinking !== undefined) runner.thinking = body.thinking || null;
      if (body.eager !== undefined) runner.eager = !!body.eager;
      saveRunnerConfig(runner);
    }
  }

  return NextResponse.json(updated);
});

export const DELETE = withUserAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  deleteAgent(id);
  if (agent?.type === "harbour") {
    removeRunnerConfig(id);
  }
  return NextResponse.json({ ok: true });
});
