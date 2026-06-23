import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { deleteUser, getUserById, updateUser } from "@/lib/db/queries";
import { optionalBoolean, optionalString, readJson } from "@/lib/http";

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
  const body = await readJson(req);
  const data: { displayName?: string; isInstanceAdmin?: boolean } = {};
  const displayName = optionalString(body.displayName, "displayName");
  if (displayName !== undefined) data.displayName = displayName.trim();
  const isInstanceAdmin = optionalBoolean(body.isInstanceAdmin, "isInstanceAdmin");
  if (isInstanceAdmin !== undefined) data.isInstanceAdmin = isInstanceAdmin;
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
