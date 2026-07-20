import { NextResponse } from "next/server";
import { getActorFromAuth, withAgentOrUser, withAuthenticatedUser } from "@/lib/auth";
import { createDoc, listDocs } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString, resolveProjectId } from "@/lib/http";

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listDocs(projectId));
});

// Docs are created by dashboard users and by agents (per the agent API guide).
export const POST = withAgentOrUser(async (req, auth) => {
  const body = await readJson(req);
  const title = requireNonEmptyString(body.title, "title");
  const content = optionalString(body.content, "content");

  // Agents default to their home project unless an explicit projectId is supplied.
  const projectId = resolveProjectId(req, body, auth);

  const { actorType, actorId } = getActorFromAuth(auth);
  const doc = createDoc(projectId, title, content, actorType, actorId);
  return NextResponse.json(doc, { status: 201 });
});
