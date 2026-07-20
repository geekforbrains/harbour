import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getEnvVarById, getJobById, linkEnvVarToJob } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await readJson(req);
  const envVarId = requireNonEmptyString(body.envVarId, "envVarId");
  if (!getEnvVarById(envVarId)) {
    return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  }

  linkEnvVarToJob(id, envVarId);
  return NextResponse.json({ ok: true }, { status: 201 });
});
