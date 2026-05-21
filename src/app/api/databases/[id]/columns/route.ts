import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getDatabaseById, addColumn } from "@/lib/db/queries";

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const db = getDatabaseById(id);
  if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

  const body = await req.json();
  if (!body.name || !body.type) {
    return NextResponse.json({ error: "name and type are required" }, { status: 400 });
  }

  try {
    const updated = addColumn(id, body);
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
});
