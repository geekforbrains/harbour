import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRunById, setRunTitle } from "@/lib/db/queries";
import { MAX_TITLE_LENGTH, normalizeTitle } from "@/lib/run-title";

export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    if (auth.type === "agent" && run.agent_id !== auth.agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auth.type === "workflow_runner") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const title = normalizeTitle((body as { title?: unknown })?.title);
    if (!title) {
      return NextResponse.json(
        { error: `title must be a non-empty string (max ${MAX_TITLE_LENGTH} chars)` },
        { status: 400 },
      );
    }

    return NextResponse.json(setRunTitle(id, title));
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("run", p.id),
  },
);
