import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { unlinkDocFromJob } from "@/lib/db/queries";

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id, docId } = await params;
  unlinkDocFromJob(id, docId);
  return NextResponse.json({ ok: true });
});
