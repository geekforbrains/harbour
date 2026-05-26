import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getDatabaseById, updateRow, deleteRow } from "@/lib/db/queries";

const dbOrg = (p: Record<string, string>) => orgIdForResource("database", p.id);

export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
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
  },
  { role: "editor", orgFromParams: dbOrg }
);

export const DELETE = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id, rowId } = await params;
    const db = getDatabaseById(id);
    if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

    try {
      deleteRow(id, parseInt(rowId));
      return NextResponse.json({ ok: true });
    } catch (error: any) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: dbOrg }
);
