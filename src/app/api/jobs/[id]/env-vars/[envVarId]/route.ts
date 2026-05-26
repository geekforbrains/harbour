import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { unlinkEnvVarFromJob } from "@/lib/db/queries";

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id, envVarId } = await params;
    unlinkEnvVarFromJob(id, envVarId);
    return NextResponse.json({ ok: true });
  }
);
