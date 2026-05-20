import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { unlinkEnvVarFromJob } from "@/lib/db/queries";

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id, envVarId } = await params;
  unlinkEnvVarFromJob(id, envVarId);
  return NextResponse.json({ ok: true });
});
