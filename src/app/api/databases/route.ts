import { NextResponse } from "next/server";
import { withOrgAuth, withAgentOrUser } from "@/lib/auth";
import { orgIdForProject } from "@/lib/db/access";
import { listDatabases, createDatabase, getDatabaseByName } from "@/lib/db/queries";

export const GET = withOrgAuth(
  async (req, auth) => {
    const projectId = req.nextUrl.searchParams.get("projectId") || null;
    return NextResponse.json(listDatabases(auth.orgId, projectId));
  },
  { role: "viewer" }
);

// Created by dashboard users and by agents (per the agent API guide).
export const POST = withAgentOrUser(
  async (req, auth) => {
    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!body.columns?.length) return NextResponse.json({ error: "at least one column is required" }, { status: 400 });

    const projectId =
      body.projectId ??
      req.nextUrl.searchParams.get("projectId") ??
      (auth.type === "agent" ? auth.projectId : null);

    // A client-supplied project must belong to the caller's org.
    if (projectId && orgIdForProject(projectId) !== auth.orgId) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }

    // If a database already exists by name in this scope, return it.
    const existing = getDatabaseByName(auth.orgId, projectId, body.name);
    if (existing) return NextResponse.json(existing);

    try {
      const db = createDatabase(auth.orgId, projectId, body.name, body.columns);
      return NextResponse.json(db, { status: 201 });
    } catch (error: any) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  },
  { role: "editor" }
);
