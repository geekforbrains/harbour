import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { unlinkEnvVarFromJob } from "@/lib/db/queries";

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id, envVarId } = await params;
  unlinkEnvVarFromJob(id, envVarId);
  return NextResponse.json({ ok: true });
});
