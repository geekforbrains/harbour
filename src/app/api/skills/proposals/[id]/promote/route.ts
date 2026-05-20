import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { promoteSkillProposal } from "@/lib/db/queries";

export const POST = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  const skill = promoteSkillProposal(id);
  if (!skill) return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  return NextResponse.json(skill);
});
