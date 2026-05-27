import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import {
  getOrgById,
  getUserById,
  addMembership,
  listMemberships,
} from "@/lib/db/queries";

/** Instance-admin-only: list an org's members (user id, email, name, role). */
export const GET = withInstanceAdmin(async (_req, _auth, ctx) => {
  const { id } = await ctx.params;
  if (!getOrgById(id)) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  return NextResponse.json(listMemberships(id));
});

/**
 * Instance-admin-only: add (or change the role of) a user's membership in an
 * org. Body: { userId, role: 'editor' | 'viewer' }. Instance admins must not
 * also carry explicit memberships, so adding one for an instance admin is
 * rejected — they already have access everywhere.
 */
export const POST = withInstanceAdmin(async (req, _auth, ctx) => {
  const { id: orgId } = await ctx.params;
  if (!getOrgById(orgId)) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const userId = typeof body.userId === "string" ? body.userId : "";
  const role = body.role === "editor" || body.role === "viewer" ? body.role : null;
  if (!userId || !role) {
    return NextResponse.json({ error: "userId and role ('editor'|'viewer') are required" }, { status: 400 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (user.is_instance_admin) {
    return NextResponse.json(
      { error: "Instance admins already have access to every org and cannot hold explicit memberships" },
      { status: 400 }
    );
  }
  addMembership(userId, orgId, role);
  return NextResponse.json({ ok: true, userId, orgId, role }, { status: 201 });
});
