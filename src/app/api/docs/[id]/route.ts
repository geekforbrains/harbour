import { NextResponse } from "next/server";
import { getActorFromAuth, withAgentOrUser, withResourceAuth } from "@/lib/auth";
import { orgIdForResource } from "@/lib/db/access";
import { deleteDoc, getDocById, renameDoc, updateDoc } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withResourceAuth("doc", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const doc = getDocById(id);
    if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });
    return NextResponse.json(doc);
  },
);

// Updated by dashboard users and by agents (per the agent API guide).
export const PUT = withAgentOrUser(
  async (req, auth, { params }) => {
    const { id } = await params;
    const existing = getDocById(id);
    if (!existing) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

    const body = await readJson(req);
    const { actorType, actorId } = getActorFromAuth(auth);

    if (body.title !== undefined) {
      // A present title must be non-blank — don't let an update clear it.
      renameDoc(id, requireNonEmptyString(body.title, "title"));
    }
    if (body.content !== undefined) {
      updateDoc(id, optionalString(body.content, "content") ?? "", actorType, actorId);
    }

    return NextResponse.json(getDocById(id));
  },
  {
    role: "editor",
    orgFromParams: (p) => orgIdForResource("doc", p.id),
  },
);

export const DELETE = withResourceAuth("doc", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    deleteDoc(id);
    return NextResponse.json({ ok: true });
  },
);
