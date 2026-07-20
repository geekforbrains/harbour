import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getDocById, getJobById, linkDocToJob } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await readJson(req);
  const docId = requireNonEmptyString(body.docId, "docId");
  if (!getDocById(docId)) {
    return NextResponse.json({ error: "Doc not found" }, { status: 404 });
  }

  linkDocToJob(id, docId);
  return NextResponse.json({ ok: true }, { status: 201 });
});
