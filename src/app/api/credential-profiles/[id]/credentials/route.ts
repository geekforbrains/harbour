import { NextResponse } from "next/server";
import { withUserAuth } from "@/lib/auth";
import {
  getCredentialProfileById,
  listProviderCredentials,
  upsertProviderCredential,
} from "@/lib/db/queries";

export const GET = withUserAuth(async (_req, _auth, { params }) => {
  const { id } = await params;
  const profile = getCredentialProfileById(id);
  if (!profile) return NextResponse.json({ error: "Credential profile not found" }, { status: 404 });
  return NextResponse.json(listProviderCredentials(id));
});

export const POST = withUserAuth(async (req, _auth, { params }) => {
  const { id } = await params;
  const profile = getCredentialProfileById(id);
  if (!profile) return NextResponse.json({ error: "Credential profile not found" }, { status: 404 });

  const body = await req.json();
  if (!body.provider?.trim() || !body.envName?.trim() || !body.value?.trim()) {
    return NextResponse.json({ error: "provider, envName, and value are required" }, { status: 400 });
  }

  let credential;
  try {
    credential = upsertProviderCredential({
      profileId: id,
      provider: body.provider,
      envName: body.envName,
      value: body.value,
      accountEmail: body.accountEmail ?? body.account_email ?? null,
      status: body.status ?? "active",
      metadata: body.metadata ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to store credential";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json(credential, { status: 201 });
});
