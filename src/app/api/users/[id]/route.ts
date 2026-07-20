import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { countUsers, deleteUser, getUserById, updateUser } from "@/lib/db/queries";
import { optionalString, readJson } from "@/lib/http";

/**
 * Rename a user. Other fields (email, password) are not editable here;
 * password is set via the set-password link flow.
 */
export const PUT = withAuthenticatedUser(async (req, _auth, ctx) => {
  const { id } = await ctx.params;
  const user = getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const body = await readJson(req);
  const data: { displayName?: string } = {};
  const displayName = optionalString(body.displayName, "displayName");
  if (displayName !== undefined) data.displayName = displayName.trim();
  const updated = updateUser(id, data);
  return NextResponse.json(updated);
});

/** Delete a user — except the last one, which would lock everyone out. */
export const DELETE = withAuthenticatedUser(async (_req, _auth, ctx) => {
  const { id } = await ctx.params;
  const user = getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (countUsers() <= 1) {
    return NextResponse.json({ error: "Cannot delete the last user" }, { status: 400 });
  }
  deleteUser(id);
  return NextResponse.json({ ok: true });
});
