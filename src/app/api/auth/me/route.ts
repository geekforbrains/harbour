import { type NextRequest, NextResponse } from "next/server";
import { getIdentityFromRequest } from "@/lib/auth";
import { getUserById } from "@/lib/db/queries";

/**
 * Identity echo. Accepts any authenticated caller (user session, API key,
 * runner token, or run exec token) and returns who they are.
 */
export const GET = async (req: NextRequest) => {
  const identity = getIdentityFromRequest(req);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (identity.type === "user") {
    return NextResponse.json({ type: "user", user: getUserById(identity.userId) });
  }

  if (identity.type === "runner") {
    return NextResponse.json({
      type: "runner",
      runner: { id: identity.runnerId, name: identity.runnerName, tier: identity.tier },
    });
  }

  // Executor (run exec token).
  return NextResponse.json({ type: "executor", run_id: identity.runId });
};
