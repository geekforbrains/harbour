import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { isRunning, stop } from "@/lib/captain/process-manager";
import { getConversation } from "@/lib/db/captain";

export const POST = withOrgAuth(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!isRunning(id)) {
      return NextResponse.json({ error: "No active response" }, { status: 400 });
    }

    stop(id);
    return NextResponse.json({ ok: true });
  },
  { role: "editor" },
);
