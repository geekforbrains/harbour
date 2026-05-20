import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { listDatabases, createDatabase, getDatabaseByName } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listDatabases(projectId, workspaceId));
});

export const POST = withAuth(async (req) => {
  const body = await req.json();
  if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!body.columns?.length) return NextResponse.json({ error: "at least one column is required" }, { status: 400 });

  // If database already exists by name, return it
  const existing = getDatabaseByName(body.name);
  if (existing) return NextResponse.json(existing);

  try {
    const db = createDatabase(body.name, body.columns);
    return NextResponse.json(db, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create database";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
