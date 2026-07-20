import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getDocById, getDocRevisions } from "@/lib/db/queries";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getDocById(id)) return NextResponse.json({ error: "Doc not found" }, { status: 404 });
  return NextResponse.json(getDocRevisions(id));
});
