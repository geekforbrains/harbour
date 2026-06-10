import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/db/queries";

export const GET = withOrgAuth(
  async (_req, auth) => {
    return NextResponse.json(listProjects(auth.orgId));
  },
  { role: "viewer" },
);

export const POST = withOrgAuth(
  async (req, auth) => {
    const body = await req.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const project = createProject(auth.orgId, body.name.trim());
    return NextResponse.json(project, { status: 201 });
  },
  { role: "editor" },
);
