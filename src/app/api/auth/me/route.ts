import { NextRequest, NextResponse } from "next/server";
import { getIdentityFromRequest } from "@/lib/auth";
import { getUserById, getAgentById, listOrgsForUser } from "@/lib/db/queries";

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
    const orgs = listOrgsForUser(identity.userId);
    return NextResponse.json({ type: "user", user, orgs });
  }

  const agent = getAgentById(identity.agentId);
  return NextResponse.json({ type: "agent", agent });
};
