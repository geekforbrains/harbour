import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { rejectSkillProposal } from "@/lib/db/queries";

export const POST = withUserAuth(async (req, _auth, { params }) => {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const proposal = rejectSkillProposal(id, body.reason);
  if (!proposal) return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  return NextResponse.json(proposal);
});
