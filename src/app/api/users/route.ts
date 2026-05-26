import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { listUsers } from "@/lib/db/queries";

export const GET = withInstanceAdmin(async () => {
  return NextResponse.json(listUsers());
});
