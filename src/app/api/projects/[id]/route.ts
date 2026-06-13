import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { archiveProject, getProjectById, updateProject } from "@/lib/db/queries";
import { optionalString, readJson } from "@/lib/http";

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
    const body = await readJson(req);
    const data: { name?: string } = {};
    const name = optionalString(body.name, "name");
    if (name !== undefined) data.name = name;
    const project = updateProject(id, data);
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
