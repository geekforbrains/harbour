import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { getRunById, updateRunStatus, addRunActivity } from "@/lib/db/queries";

const RETRYABLE = ["failed", "skipped", "killed"];

export const POST = withUserAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  if (!RETRYABLE.includes(run.status)) {
    return NextResponse.json({ error: `Can only retry runs with status: ${RETRYABLE.join(", ")}` }, { status: 400 });
  }

  const updated = updateRunStatus(id, "pending");
  addRunActivity(id, "system", null, "System", `Run retried by **${auth.displayName}**`);

  return NextResponse.json(updated);
});
