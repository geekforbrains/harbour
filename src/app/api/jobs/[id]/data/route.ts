import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getJobById, linkDatabaseToJob } from "@/lib/db/queries";

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await req.json();
  if (!body.databaseId) return NextResponse.json({ error: "databaseId is required" }, { status: 400 });

  linkDatabaseToJob(id, body.databaseId);
  return NextResponse.json({ ok: true }, { status: 201 });
});
