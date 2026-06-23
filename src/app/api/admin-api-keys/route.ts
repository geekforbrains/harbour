import { NextResponse } from "next/server";
import { withInstanceAdmin } from "@/lib/auth";
import { createAdminApiKey, listAdminApiKeys } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withInstanceAdmin(async () => {
  return NextResponse.json(listAdminApiKeys());
});

export const POST = withInstanceAdmin(async (req, auth) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  const key = createAdminApiKey(name, auth.userId);
  return NextResponse.json(key, { status: 201 });
});
