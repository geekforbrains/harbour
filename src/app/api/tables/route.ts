import { NextResponse } from "next/server";
import { withAgentOrUser, withAuthenticatedUser } from "@/lib/auth";
import type { ColumnDef } from "@/lib/db/queries";
import { createTable, getTableByName, listTables } from "@/lib/db/queries";
import { badRequest, readJson, requireNonEmptyString, resolveProjectId } from "@/lib/http";

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listTables(projectId));
});

// Created by dashboard users and by agents (per the agent API guide).
export const POST = withAgentOrUser(async (req, auth) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    badRequest("at least one column is required");
  }
  // Column name/type/default are validated in createTable — it owns the DDL, so
  // it owns the allow-list. Here we only check the container shape.
  for (const col of body.columns) {
    if (col === null || typeof col !== "object") badRequest("each column must be an object");
  }
  const columns = body.columns as ColumnDef[];

  // Agents default to their home project unless an explicit projectId is supplied.
  const projectId = resolveProjectId(req, body, auth);

  // If a table already exists by name in this project, return it.
  const existing = getTableByName(projectId, name);
  if (existing) return NextResponse.json(existing);

  try {
    const table = createTable(projectId, name, columns);
    return NextResponse.json(table, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
