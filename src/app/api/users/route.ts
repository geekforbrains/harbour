import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { createUser, listMemberships, listOrgs, listUsers } from "@/lib/db/queries";
import { getDb } from "@/lib/db/schema";
import { optionalBoolean, optionalString, readJson, requireNonEmptyString } from "@/lib/http";

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  is_instance_admin: number;
  created_at: number;
};
type MembershipRow = { user_id: string; role: "editor" | "viewer" };

/**
 * Instance-admin-only: list all users, each enriched with their org memberships
 * (org id, name, and role). Memberships are pivoted from the per-org membership
 * tables so the admin console can render a user-centric view in one request.
 */
export const GET = withInstanceAdmin(async () => {
  const users = listUsers() as UserRow[];
  const orgs = listOrgs() as { id: string; name: string }[];

  // Build user_id -> memberships[] by walking each org's member list once.
  const byUser = new Map<
    string,
    { org_id: string; org_name: string; role: "editor" | "viewer" }[]
  >();
  for (const org of orgs) {
    const members = listMemberships(org.id) as MembershipRow[];
    for (const m of members) {
      const list = byUser.get(m.user_id) ?? [];
      list.push({ org_id: org.id, org_name: org.name, role: m.role });
      byUser.set(m.user_id, list);
    }
  }

  // A NULL password_hash means the set-password link hasn't been consumed yet.
  // listUsers() intentionally omits the hash; read the bare presence flag here
  // so the console can surface "pending" without ever shipping the hash.
  const pendingRows = getDb().prepare(`SELECT id, password_hash FROM users`).all() as {
    id: string;
    password_hash: string | null;
  }[];
  const pendingById = new Map(pendingRows.map((r) => [r.id, r.password_hash === null]));

  return NextResponse.json(
    users.map((u) => ({
      ...u,
      pending: pendingById.get(u.id) ?? false,
      memberships: byUser.get(u.id) ?? [],
    })),
  );
});

/**
 * Instance-admin-only: create a user with no password yet (password_hash stays
 * NULL until a set-password link is consumed). Returns the created user row.
 */
export const POST = withInstanceAdmin(async (req) => {
  const body = await readJson(req);
  const email = requireNonEmptyString(body.email, "email");
  const displayName = optionalString(body.displayName, "displayName")?.trim() ?? "";
  const user = createUser(email, null, displayName || email, {
    isInstanceAdmin: optionalBoolean(body.isInstanceAdmin, "isInstanceAdmin") ?? false,
  });
  return NextResponse.json(user, { status: 201 });
});
