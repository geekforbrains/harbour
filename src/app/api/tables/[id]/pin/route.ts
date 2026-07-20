import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getTableById, toggleTablePinned } from "@/lib/db/queries";

export const POST = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const table = getTableById(id);
  if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

  const updated = toggleTablePinned(id);
  return NextResponse.json(updated);
});
