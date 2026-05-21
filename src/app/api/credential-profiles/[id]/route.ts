import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { getCredentialProfileWithCredentials } from "@/lib/db/queries";

export const GET = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  const profile = getCredentialProfileWithCredentials(id);
  if (!profile) return NextResponse.json({ error: "Credential profile not found" }, { status: 404 });
  return NextResponse.json(profile);
});
