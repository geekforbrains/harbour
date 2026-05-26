import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getDatabaseById, deleteDatabase, getDatabaseMigrations, getJobsForDatabase } from "@/lib/db/queries";

export const GET = withResourceAuth("database", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const db = getDatabaseById(id);
    if (!db) return NextResponse.json({ error: "Database not found" }, { status: 404 });

    const migrations = getDatabaseMigrations(id);
    const jobs = getJobsForDatabase(id);
    return NextResponse.json({ ...db, migrations, jobs });
  }
);

export const DELETE = withResourceAuth("database", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    deleteDatabase(id);
    return NextResponse.json({ ok: true });
  }
);
