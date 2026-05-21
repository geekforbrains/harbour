import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import { listCredentialProfiles, upsertCredentialProfile } from "@/lib/db/queries";

export const GET = withUserAuth(async () => {
  return NextResponse.json(listCredentialProfiles());
});

export const POST = withUserAuth(async (req, auth) => {
  const body = await req.json();
  if (!body.email?.trim()) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const profile = upsertCredentialProfile({
    email: body.email,
    displayName: body.displayName ?? body.display_name ?? null,
    notes: body.notes ?? null,
    createdByUserId: auth.userId,
  });
  return NextResponse.json(profile, { status: 201 });
});
