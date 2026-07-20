import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { unlinkDocFromJob } from "@/lib/db/queries";

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id, docId } = await params;
  unlinkDocFromJob(id, docId);
  return NextResponse.json({ ok: true });
});
