import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { getOrgById, removeMembership } from "@/lib/db/queries";

/** Instance-admin-only: remove a user's membership from an org. */
export const DELETE = withInstanceAdmin(async (_req, _auth, ctx) => {
  const { id: orgId, userId } = await ctx.params;
  if (!getOrgById(orgId)) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  removeMembership(userId, orgId);
  return NextResponse.json({ ok: true });
});
