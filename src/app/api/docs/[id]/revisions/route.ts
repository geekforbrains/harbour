import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getDocRevisions } from "@/lib/db/queries";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  return NextResponse.json(getDocRevisions(id));
});
