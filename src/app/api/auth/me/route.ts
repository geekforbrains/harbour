import { type NextRequest, NextResponse } from "next/server";
import { getIdentityFromRequest } from "@/lib/auth";
import { getAgentById, getUserById, listOrgs, listOrgsForUser } from "@/lib/db/queries";

/**
 * Identity echo. Accepts any authenticated caller (user session, admin key,
 * agent key, runner token, or run exec token) and returns who they are. Users
 * also get their org memberships so the client can pick an active org.
 */
export const GET = async (req: NextRequest) => {
  const identity = getIdentityFromRequest(req);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (identity.type === "user") {
    const user = getUserById(identity.userId);
    // Instance admins have no memberships by design but can access every org,
    // so surface all orgs to them; regular users see only their memberships.
    const orgs = user?.is_instance_admin ? listOrgs() : listOrgsForUser(identity.userId);
    return NextResponse.json({ type: "user", user, orgs });
  }

  if (identity.type === "agent") {
    const agent = getAgentById(identity.agentId);
    return NextResponse.json({ type: "agent", agent });
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
