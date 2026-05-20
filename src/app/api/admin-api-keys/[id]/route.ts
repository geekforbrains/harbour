import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { deleteAdminApiKey } from "@/lib/db/queries";

export const DELETE = withUserAuth(async (req, auth, { params }) => {
  const { id } = await params;
  deleteAdminApiKey(id);
  return NextResponse.json({ ok: true });
});
