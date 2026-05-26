import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, linkEnvVarToJob } from "@/lib/db/queries";

export const POST = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await req.json();
    if (!body.envVarId) {
      return NextResponse.json({ error: "envVarId is required" }, { status: 400 });
    }

    // The env var must belong to the same org as the job — never link cross-org.
    if (orgIdForResource("env_var", body.envVarId) !== auth.orgId) {
      return NextResponse.json({ error: "Env var not found" }, { status: 404 });
    }

    linkEnvVarToJob(id, body.envVarId);
    return NextResponse.json({ ok: true });
  }
);
