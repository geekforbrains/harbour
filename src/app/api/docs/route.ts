import { NextResponse } from "next/server";
import { withAuth, getActorFromAuth } from "@/lib/auth";
import { listDocs, createDoc } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listDocs(projectId, workspaceId));
});

export const POST = withAuth(async (req, auth) => {
  const body = await req.json();
  if (!body.title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const { actorType, actorId } = getActorFromAuth(auth);
  const doc = createDoc(body.title, body.content, actorType, actorId);
  return NextResponse.json(doc, { status: 201 });
});
