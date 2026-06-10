import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { activeMessageId, isRunning } from "@/lib/captain/process-manager";
import { getConversation } from "@/lib/db/captain";

export const GET = withOrgAuth(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      running: isRunning(id),
      activeMessageId: activeMessageId(id),
    });
  },
  { role: "viewer" },
);
