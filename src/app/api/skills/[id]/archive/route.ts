import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { archiveSkill } from "@/lib/db/queries";

export const POST = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  const skill = archiveSkill(id);
  if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  return NextResponse.json(skill);
});
