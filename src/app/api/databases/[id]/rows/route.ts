import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getDatabaseById, getRows, insertRows } from "@/lib/db/queries";

const dbOrg = (p: Record<string, string>) => orgIdForResource("database", p.id);

export const GET = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const db = getDatabaseById(id);
    if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const orderBy = url.searchParams.get("orderBy") || undefined;
    const order = (url.searchParams.get("order") || "DESC") as "ASC" | "DESC";

    const result = getRows(id, { limit, offset, orderBy, order });
    return NextResponse.json(result);
  },
  { role: "viewer", orgFromParams: dbOrg },
);

export const POST = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const db = getDatabaseById(id);
    if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

    const body = await req.json();
    const rows = Array.isArray(body) ? body : [body];

    try {
      const result = insertRows(id, rows);
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: dbOrg },
);
