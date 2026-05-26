import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getAgentById, rotateAgentKey } from "@/lib/db/queries";

export const POST = withResourceAuth("agent", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const existing = getAgentById(id);
    if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    const apiKey = rotateAgentKey(id);
    return NextResponse.json({ apiKey });
  }
);
