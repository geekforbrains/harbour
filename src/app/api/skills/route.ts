import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { listSkills } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  return NextResponse.json(listSkills({
    q: req.nextUrl.searchParams.get("q") || undefined,
    status: req.nextUrl.searchParams.get("status") || undefined,
    scope: req.nextUrl.searchParams.get("scope") || undefined,
  }));
});
