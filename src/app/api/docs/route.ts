import { NextResponse } from "next/server";
import { getActorFromAuth, withAgentOrUser, withOrgAuth } from "@/lib/auth";
import { orgIdForProject } from "@/lib/db/access";
import { createDoc, listDocs } from "@/lib/db/queries";

export const GET = withOrgAuth(
  async (req, auth) => {
    const projectId = req.nextUrl.searchParams.get("projectId") || null;
    return NextResponse.json(listDocs(auth.orgId, projectId));
  },
  { role: "viewer" },
);

// Docs are created by dashboard users and by agents (per the agent API guide).
export const POST = withAgentOrUser(
  async (req, auth) => {
    const body = await req.json();
    if (!body.title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    // Project-level when projectId given; otherwise org-level. Agents default
    // to their home project unless an explicit projectId is supplied.
    const projectId =
      body.projectId ??
      req.nextUrl.searchParams.get("projectId") ??
      (auth.type === "agent" ? auth.projectId : null);

    // A client-supplied project must belong to the caller's org.
    if (projectId && orgIdForProject(projectId) !== auth.orgId) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }

    const { actorType, actorId } = getActorFromAuth(auth);
    const doc = createDoc(auth.orgId, projectId, body.title, body.content, actorType, actorId);
    return NextResponse.json(doc, { status: 201 });
  },
  { role: "editor" },
);
