import { NextResponse } from "next/server";
import { withAgentOrUser, withOrgAuth } from "@/lib/auth";
import { orgIdForProject } from "@/lib/db/access";
import type { ColumnDef } from "@/lib/db/queries";
import { createDatabase, getDatabaseByName, listDatabases } from "@/lib/db/queries";
import {
  assertOneOf,
  badRequest,
  optionalString,
  readJson,
  requireNonEmptyString,
} from "@/lib/http";

const COLUMN_TYPES = ["TEXT", "INTEGER", "REAL"] as const;

export const GET = withOrgAuth(
  async (req, auth) => {
    const projectId = req.nextUrl.searchParams.get("projectId") || null;
    return NextResponse.json(listDatabases(auth.orgId, projectId));
  },
  { role: "viewer" },
);

// Created by dashboard users and by agents (per the agent API guide).
export const POST = withAgentOrUser(
  async (req, auth) => {
    const body = await readJson(req);
    const name = requireNonEmptyString(body.name, "name");
    if (!Array.isArray(body.columns) || body.columns.length === 0) {
      badRequest("at least one column is required");
    }
    // Each column's type is interpolated into CREATE TABLE DDL, so allow-list it
    // (case-insensitive) here rather than letting SQLite fail with an opaque
    // exec error. Column names are sanitized in createDatabase.
    const columns = body.columns.map((col) => {
      if (col === null || typeof col !== "object") {
        badRequest("each column must be an object");
      }
      const c = col as Record<string, unknown>;
      const type = assertOneOf(String(c.type).toUpperCase(), COLUMN_TYPES, "column type");
      return { ...c, type };
    });

    const projectId =
      optionalString(body.projectId, "projectId") ??
      req.nextUrl.searchParams.get("projectId") ??
      (auth.type === "agent" ? auth.projectId : null);

    // A client-supplied project must belong to the caller's org.
    if (projectId && orgIdForProject(projectId) !== auth.orgId) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }

    // If a database already exists by name in this scope, return it.
    const existing = getDatabaseByName(auth.orgId, projectId, name);
    if (existing) return NextResponse.json(existing);

    try {
      const db = createDatabase(auth.orgId, projectId, name, columns as ColumnDef[]);
      return NextResponse.json(db, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor" },
);
