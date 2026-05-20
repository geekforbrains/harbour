import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { listProjects, createProject } from "@/lib/db/queries";

export const GET = withUserAuth(async (req) => {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listProjects(workspaceId));
});

export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const project = createProject(body.name.trim(), body.workspaceId || body.workspace_id || null);
  return NextResponse.json(project, { status: 201 });
});
