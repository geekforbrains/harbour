import { NextResponse } from "next/server";
import { withResourceAuth, withAgentOrUser, getActorFromAuth } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { getDocById, updateDoc, renameDoc, deleteDoc } from "@/lib/db/queries";

export const GET = withResourceAuth("doc", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const doc = getDocById(id);
    if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });
    return NextResponse.json(doc);
  }
);

// Updated by dashboard users and by agents (per the agent API guide).
export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const existing = getDocById(id);
    if (!existing) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

    const body = await req.json();
    const { actorType, actorId } = getActorFromAuth(auth);

    if (body.title !== undefined) {
      renameDoc(id, body.title);
    }
    if (body.content !== undefined) {
      updateDoc(id, body.content, actorType, actorId);
    }

    return NextResponse.json(getDocById(id));
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("doc", p.id),
  }
);

export const DELETE = withResourceAuth("doc", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    deleteDoc(id);
    return NextResponse.json({ ok: true });
  }
);
