import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { listAdminApiKeys, createAdminApiKey } from "@/lib/db/queries";

export const GET = withInstanceAdmin(async () => {
  return NextResponse.json(listAdminApiKeys());
});

export const POST = withInstanceAdmin(async (req, auth) => {
  const body = await req.json();
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const key = createAdminApiKey(body.name.trim(), auth.userId);
  return NextResponse.json(key, { status: 201 });
});
