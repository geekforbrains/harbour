import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { listUsers } from "@/lib/db/queries";

export const GET = withAuth(async () => {
  return NextResponse.json(listUsers());
});
