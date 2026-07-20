import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createUser, listUsers } from "@/lib/db/queries";
import { getDb, isUniqueViolation } from "@/lib/db/schema";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
};

/** List all users, each flagged `pending` until its set-password link is consumed. */
export const GET = withAuthenticatedUser(async () => {
  const users = listUsers() as UserRow[];

  // A NULL password_hash means the set-password link hasn't been consumed yet.
  // listUsers() intentionally omits the hash; read the bare presence flag here
  // so the console can surface "pending" without ever shipping the hash.
  const pendingRows = getDb().prepare(`SELECT id, password_hash FROM users`).all() as {
    id: string;
    password_hash: string | null;
  }[];
  const pendingById = new Map(pendingRows.map((r) => [r.id, r.password_hash === null]));

  return NextResponse.json(users.map((u) => ({ ...u, pending: pendingById.get(u.id) ?? false })));
});

/**
 * Create a user with no password yet (password_hash stays NULL until a
 * set-password link is consumed). Returns the created user row.
 */
export const POST = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  const email = requireNonEmptyString(body.email, "email");
  const displayName = optionalString(body.displayName, "displayName")?.trim() ?? "";
  try {
    const user = createUser(email, null, displayName || email);
    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    // users.email is UNIQUE; surface a duplicate as a 409, not a 500.
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
    }
    throw err;
  }
});
