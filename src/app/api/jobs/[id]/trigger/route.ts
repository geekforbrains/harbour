import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getJobById, triggerJobRun } from "@/lib/db/queries";

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let extraInstructions: string | undefined;
  try {
    const body = await req.json();
    if (body.instructions) extraInstructions = body.instructions;
  } catch {
    // No body is fine — trigger without extra instructions
  }

  const result = triggerJobRun(id, extraInstructions);
  if (!result) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

  return NextResponse.json(result, { status: 201 });
});
