import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getJobById, linkEnvVarToJob } from "@/lib/db/queries";

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await req.json();
  if (!body.envVarId) {
    return NextResponse.json({ error: "envVarId is required" }, { status: 400 });
  }

  linkEnvVarToJob(id, body.envVarId);
  return NextResponse.json({ ok: true });
});
