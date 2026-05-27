import { NextResponse } from "next/server";
import { withResourceAuth, withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, addRunOutput, listRunOutput, isKillRequested } from "@/lib/db/queries";

export const GET = withResourceAuth("run", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const afterId = parseInt(req.nextUrl.searchParams.get("after") || "0", 10);
    return NextResponse.json(listRunOutput(id, afterId));
  }
);

export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== null && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const events = Array.isArray(body) ? body : [body];

    if (events.length === 0 || !events.every((e: any) => e.event_type)) {
      return NextResponse.json({ error: "event_type is required for each event" }, { status: 400 });
    }

    addRunOutput(id, events.map((e: any) => ({
      event_type: e.event_type,
      content: e.content || null,
      tool_name: e.tool_name || null,
    })));

    // Piggyback the kill signal onto the runner's frequent output POSTs.
    return NextResponse.json({ ok: true, kill_requested: isKillRequested(id) }, { status: 201 });
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  }
);
