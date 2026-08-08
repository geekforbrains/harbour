import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { addColumn, getTableById } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const POST = withAgentOrUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const table = getTableById(id);
  if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

  const body = await readJson(req);
  requireNonEmptyString(body.name, "name");

  try {
    // Type and default are validated in addColumn, which owns the DDL.
    const updated = addColumn(id, body as Parameters<typeof addColumn>[1]);
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
