import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { unlinkDatabaseFromJob } from "@/lib/db/queries";

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id, dataId } = await params;
  unlinkDatabaseFromJob(id, dataId);
  return NextResponse.json({ ok: true });
});
