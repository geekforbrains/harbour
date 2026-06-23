import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { deleteRow, getTableById, updateRow } from "@/lib/db/queries";
import { readJson } from "@/lib/http";

const tableOrg = (p: Record<string, string>) => orgIdForResource("table", p.id);

export const PUT = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id, rowId } = await params;
    const table = getTableById(id);
    if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

    const body = await readJson(req);
    try {
      const row = updateRow(id, parseInt(rowId, 10), body);
      return NextResponse.json(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: tableOrg },
);

export const DELETE = withAgentOrUser(
  async (_req, _auth, { params }) => {
    const { id, rowId } = await params;
    const table = getTableById(id);
    if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

    try {
      deleteRow(id, parseInt(rowId, 10));
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: tableOrg },
);
