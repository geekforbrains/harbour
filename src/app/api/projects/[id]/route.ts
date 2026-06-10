import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { archiveProject, getProjectById, updateProject } from "@/lib/db/queries";

export const GET = withResourceAuth("project", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const project = getProjectById(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(project);
  },
);

export const PUT = withResourceAuth("project", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const body = await req.json();
    const project = updateProject(id, body);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(project);
  },
);

// Soft-delete (archive) is the normal deletion path. Hard delete is an
// admin-only escape hatch exposed elsewhere.
export const DELETE = withResourceAuth("project", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    archiveProject(id);
    return NextResponse.json({ ok: true });
  },
);
