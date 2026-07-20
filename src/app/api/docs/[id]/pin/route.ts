import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getDocById, toggleDocPinned } from "@/lib/db/queries";

export const POST = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const doc = getDocById(id);
  if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

  const updated = toggleDocPinned(id);
  return NextResponse.json(updated);
});
