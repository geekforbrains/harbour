import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, linkDocToJob } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await readJson(req);
    const docId = requireNonEmptyString(body.docId, "docId");

    // The doc must belong to the same org as the job — never link cross-org.
    if (orgIdForResource("doc", docId) !== auth.orgId) {
      return NextResponse.json({ error: "Doc not found" }, { status: 404 });
    }

    try {
      linkDocToJob(id, docId);
    } catch (error) {
      // Link guard: an org-level job may only link org-level docs.
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  },
);
