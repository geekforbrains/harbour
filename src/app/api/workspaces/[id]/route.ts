import { NextRequest, NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { getWorkspaceById, updateWorkspace, deleteWorkspace } from "@/lib/db/queries";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withUserAuth(async (req: NextRequest, auth, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const workspace = getWorkspaceById(id);
  if (!workspace) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(workspace);
});

export const PUT = withUserAuth(async (req: NextRequest, auth, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const workspace = updateWorkspace(id, await req.json());
  if (!workspace) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(workspace);
});

export const DELETE = withUserAuth(async (req: NextRequest, auth, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  deleteWorkspace(id);
  return NextResponse.json({ ok: true });
});
