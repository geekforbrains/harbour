import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getAgentById, listRunsByAgent } from "@/lib/db/queries";

export const GET = withResourceAuth("agent", "id", { role: "viewer" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const agent = getAgentById(id);
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const limit = sp.get("limit") ? Math.min(Math.max(1, Number(sp.get("limit"))), 100) : 10;
    const offset = sp.get("offset") ? Math.max(0, Number(sp.get("offset"))) : 0;
    const includeSkipped = sp.get("includeSkipped") === "1";

    return NextResponse.json(listRunsByAgent(id, limit, { includeSkipped, offset }));
  },
);
