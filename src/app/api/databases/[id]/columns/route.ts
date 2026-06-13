import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { addColumn, getDatabaseById } from "@/lib/db/queries";
import { assertOneOf, readJson, requireNonEmptyString } from "@/lib/http";

const COLUMN_TYPES = ["TEXT", "INTEGER", "REAL"] as const;

export const POST = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const db = getDatabaseById(id);
    if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

    const body = await readJson(req);
    requireNonEmptyString(body.name, "name");
    // Allow-list the type (case-insensitive) before it reaches the DDL.
    const type = assertOneOf(String(body.type).toUpperCase(), COLUMN_TYPES, "type");

    try {
      const updated = addColumn(id, { ...body, type } as Parameters<typeof addColumn>[1]);
      return NextResponse.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: (p) => orgIdForResource("database", p.id) },
);
