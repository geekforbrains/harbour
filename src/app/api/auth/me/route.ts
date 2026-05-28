import { NextRequest, NextResponse } from "next/server";
import { getIdentityFromRequest } from "@/lib/auth";
import { getUserById, getAgentById, listOrgsForUser, listOrgs } from "@/lib/db/queries";

/**
 * Identity echo. Accepts any authenticated caller (user session, admin key, or
 * agent key) and returns who they are. Users also get their org memberships so
 * the client can pick an active org.
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

  if (identity.type === "workflow_runner") {
    return NextResponse.json({
      type: "workflow_runner",
      runner: {
        id: identity.runnerId,
        name: identity.runnerName,
        org_id: identity.orgId,
      },
    });
  }

  const agent = getAgentById(identity.agentId);
  return NextResponse.json({ type: "agent", agent });
};
