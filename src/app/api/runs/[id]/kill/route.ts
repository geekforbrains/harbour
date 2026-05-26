import { NextResponse } from "next/server";
import { withResourceAuth, withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, requestKillRun, addRunActivity, isKillRequested } from "@/lib/db/queries";

/**
 * Lightweight kill-check endpoint for the runner's fallback poll. Returns just
 * the kill flag so the runner can poll cheaply without pulling the whole run.
 */
export const GET = withAgentOrUser(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ kill_requested: isKillRequested(id), status: run.status });
  },
  {
    role: "viewer",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);

export const POST = withResourceAuth("run", "id", { role: "editor" })(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (run.status !== "running") {
      return NextResponse.json(
        { error: `Cannot kill a run in status '${run.status}' — only 'running' runs can be killed.` },
        { status: 409 },
      );
    }

    const ok = requestKillRun(id);
    if (!ok) {
      return NextResponse.json({ error: "Failed to request kill" }, { status: 500 });
    }

    addRunActivity(id, "system", null, "System", `Kill requested by **${auth.displayName}**`);

    return NextResponse.json({ ok: true, kill_requested: true });
  }
);
