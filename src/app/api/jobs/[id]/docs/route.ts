import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getJobById, linkDocToJob } from "@/lib/db/queries";

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await req.json();
  if (!body.docId) return NextResponse.json({ error: "docId is required" }, { status: 400 });

  linkDocToJob(id, body.docId);
  return NextResponse.json({ ok: true }, { status: 201 });
});
