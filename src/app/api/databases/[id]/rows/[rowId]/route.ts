import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getDatabaseById, updateRow, deleteRow } from "@/lib/db/queries";

export const PUT = withAuth(async (req, auth, { params }) => {
  const { id, rowId } = await params;
  const db = getDatabaseById(id);
  if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

  const body = await req.json();
  try {
    const row = updateRow(id, parseInt(rowId), body);
    return NextResponse.json(row);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
});

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id, rowId } = await params;
  const db = getDatabaseById(id);
  if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

  try {
    deleteRow(id, parseInt(rowId));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
});
