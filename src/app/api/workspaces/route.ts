import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { listWorkspaces, createWorkspace, WorkspaceConflictError } from "@/lib/db/queries";

export const GET = withUserAuth(async () => {
  return NextResponse.json(listWorkspaces());
});

export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const workspace = createWorkspace({
      name: body.name.trim(),
      slug: body.slug,
      kind: body.kind,
      root_path: body.root_path,
      description: body.description,
    });
    return NextResponse.json(workspace, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
});
