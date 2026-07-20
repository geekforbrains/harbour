import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { deleteProject, getProjectById, updateProject } from "@/lib/db/queries";
import { optionalString, readJson } from "@/lib/http";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const project = getProjectById(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
});

export const PUT = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const body = await readJson(req);
  const data: { name?: string } = {};
  const name = optionalString(body.name, "name");
  if (name !== undefined) data.name = name;
  const project = updateProject(id, data);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
});

// ON DELETE CASCADE wipes everything beneath the project.
export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getProjectById(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  deleteProject(id);
  return NextResponse.json({ ok: true });
});
