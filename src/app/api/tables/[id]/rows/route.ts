import { NextResponse } from "next/server";
import { withAgentOrUser } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getRows, getTableById, insertRows } from "@/lib/db/queries";
import { badRequest } from "@/lib/http";

// The wire contract (docs/guide.md) allows either a single row object or an
// array of row objects, so we can't use readJson (which rejects top-level
// arrays). Parse here with the same clean-400-on-malformed semantics.
function readRowsBody(text: string): Record<string, unknown>[] {
  if (!text || text.trim() === "") badRequest("Request body must be a JSON object or array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    badRequest("Invalid JSON body");
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      badRequest("Each row must be a JSON object");
    }
  }
  return rows as Record<string, unknown>[];
}

const tableOrg = (p: Record<string, string>) => orgIdForResource("table", p.id);

export const GET = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const table = getTableById(id);
    if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const orderBy = url.searchParams.get("orderBy") || undefined;
    const order = (url.searchParams.get("order") || "DESC") as "ASC" | "DESC";

    // getRows validates orderBy against the real columns and throws on an
    // unknown one; catch it so a bad query param is a clean 400 like the
    // mutation routes below, not an opaque uncaught 500.
    try {
      const result = getRows(id, { limit, offset, orderBy, order });
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "viewer", orgFromParams: tableOrg },
);

export const POST = withAgentOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const table = getTableById(id);
    if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

    const rows = readRowsBody(await req.text());

    try {
      const result = insertRows(id, rows);
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor", orgFromParams: tableOrg },
);
