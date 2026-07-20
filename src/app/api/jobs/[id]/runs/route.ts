import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getJobById, listRunsByJob } from "@/lib/db/queries";

export const GET = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const limit = sp.get("limit") ? Math.min(Math.max(1, Number(sp.get("limit"))), 100) : 10;
  const offset = sp.get("offset") ? Math.max(0, Number(sp.get("offset"))) : 0;
  const includeSkipped = sp.get("includeSkipped") === "1";

  return NextResponse.json(listRunsByJob(id, limit, { includeSkipped, offset }));
});
