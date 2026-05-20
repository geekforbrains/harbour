import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getDatabaseById, getRows, insertRows } from "@/lib/db/queries";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const db = getDatabaseById(id);
  if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const orderBy = url.searchParams.get("orderBy") || undefined;
  const order = (url.searchParams.get("order") || "DESC") as "ASC" | "DESC";

  const result = getRows(id, { limit, offset, orderBy, order });
  return NextResponse.json(result);
});

export const POST = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const db = getDatabaseById(id);
  if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

  const body = await req.json();
  const rows = Array.isArray(body) ? body : [body];

  try {
    const result = insertRows(id, rows);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
});
