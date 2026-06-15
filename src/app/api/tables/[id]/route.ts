import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { deleteTable, getJobsForTable, getTableById, getTableMigrations } from "@/lib/db/queries";

export const GET = withResourceAuth("table", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const table = getTableById(id);
    if (!table) return NextResponse.json({ error: "Table not found" }, { status: 404 });

    const migrations = getTableMigrations(id);
    const jobs = getJobsForTable(id);
    return NextResponse.json({ ...table, migrations, jobs });
  },
);

export const DELETE = withResourceAuth("table", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    deleteTable(id);
    return NextResponse.json({ ok: true });
  },
);
