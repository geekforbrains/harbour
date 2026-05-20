import { NextResponse } from "next/server";
import { withAuth, getActorFromAuth } from "@/lib/auth";
import { getDocById, updateDoc, renameDoc, deleteDoc } from "@/lib/db/queries";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const doc = getDocById(id);
  if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });
  return NextResponse.json(doc);
});

export const PUT = withAuth(async (req, auth, { params }) => {
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
});

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  deleteDoc(id);
  return NextResponse.json({ ok: true });
});
