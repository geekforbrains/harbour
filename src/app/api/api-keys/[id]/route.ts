import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { deleteApiKey } from "@/lib/db/queries";

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!deleteApiKey(id)) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});
