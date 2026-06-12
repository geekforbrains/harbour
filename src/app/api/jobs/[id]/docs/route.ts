import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, linkDocToJob } from "@/lib/db/queries";

export const POST = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await req.json();
    if (!body.docId) return NextResponse.json({ error: "docId is required" }, { status: 400 });

    // The doc must belong to the same org as the job — never link cross-org.
    if (orgIdForResource("doc", body.docId) !== auth.orgId) {
      return NextResponse.json({ error: "Doc not found" }, { status: 404 });
    }

    try {
      linkDocToJob(id, body.docId);
    } catch (error) {
      // Link guard: an org-level job may only link org-level docs.
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  },
);
