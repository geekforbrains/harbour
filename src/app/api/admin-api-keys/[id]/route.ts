import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { deleteAdminApiKey } from "@/lib/db/queries";

export const DELETE = withInstanceAdmin(async (_req, _auth, { params }) => {
  const { id } = await params;
  deleteAdminApiKey(id);
  return NextResponse.json({ ok: true });
});
