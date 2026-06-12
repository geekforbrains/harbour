import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, linkDatabaseToJob } from "@/lib/db/queries";

export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await req.json();
    if (!body.databaseId)
      return NextResponse.json({ error: "databaseId is required" }, { status: 400 });

    // The database must belong to the same org as the job — never link cross-org.
    if (orgIdForResource("database", body.databaseId) !== auth.orgId) {
      return NextResponse.json({ error: "Database not found" }, { status: 404 });
    }

    try {
      linkDatabaseToJob(id, body.databaseId);
    } catch (error) {
      // Link guard: an org-level job may only link org-level databases.
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("job", p.id),
  },
);
