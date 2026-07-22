import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getAgentById, hasLiveRunnerForAgent } from "@/lib/db/queries";

// Pre-flight signal for the "Agent Created" dialog: is a runner already live
// for this agent's placement + CLI, independent of any queued run (a fresh
// agent has none yet, so the queued-work stalled-placement surface can't
// answer this). Not project-scoped, matching GET /api/agents/[id].
export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const agent = getAgentById(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const live =
    !!agent.cli &&
    hasLiveRunnerForAgent({ placement: agent.placement, cli: agent.cli, agentId: agent.id });
  return NextResponse.json({ live });
});
