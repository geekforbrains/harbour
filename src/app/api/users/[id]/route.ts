import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { getUserById, updateUser, deleteUser } from "@/lib/db/queries";

/**
 * Instance-admin-only: update a user — toggle instance_admin or rename. Other
 * fields (email, password) are not editable here; password is set via the
 * set-password link flow.
 */
export const PUT = withInstanceAdmin(async (req, _auth, ctx) => {
  const { id } = await ctx.params;
  const user = getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const data: { displayName?: string; isInstanceAdmin?: boolean } = {};
  if (typeof body.displayName === "string") data.displayName = body.displayName.trim();
  if (typeof body.isInstanceAdmin === "boolean") data.isInstanceAdmin = body.isInstanceAdmin;
  const updated = updateUser(id, data);
  return NextResponse.json(updated);
});

/** Instance-admin-only: delete a user. */
export const DELETE = withInstanceAdmin(async (_req, _auth, ctx) => {
  const { id } = await ctx.params;
  const user = getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  deleteUser(id);
  return NextResponse.json({ ok: true });
});
