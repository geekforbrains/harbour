import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getJobById, linkTableToJob } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await readJson(req);
    const tableId = requireNonEmptyString(body.tableId, "tableId");

    // The table must belong to the same org as the job — never link cross-org.
    if (orgIdForResource("table", tableId) !== auth.orgId) {
      return NextResponse.json({ error: "Table not found" }, { status: 404 });
    }

    try {
      linkTableToJob(id, tableId);
    } catch (error) {
      // Link guard: an org-level job may only link org-level tables.
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
