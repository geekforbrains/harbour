import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { deleteRunner, getRunnerById } from "@/lib/db/queries";

// Revoke a runner: deleting its row invalidates its token immediately (the next
// claim 401s). Runs it claimed keep their denormalized data; runs.claimed_by is
// set to NULL by the FK. Instance-admin only.
export const DELETE = withInstanceAdmin(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getRunnerById(id)) {
    return NextResponse.json({ error: "Runner not found" }, { status: 404 });
  }
  deleteRunner(id);
  return NextResponse.json({ ok: true });
});
