import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createApiKey, listApiKeys } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withAuthenticatedUser(async () => {
  return NextResponse.json(listApiKeys());
});

export const POST = withAuthenticatedUser(async (req, auth) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  const key = createApiKey(name, auth.userId);
  return NextResponse.json(key, { status: 201 });
});
