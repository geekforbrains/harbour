import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { getEnvVarById, getEnvVarDecryptedValue } from "@/lib/db/queries";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const envVar = getEnvVarById(id);
  if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

  const value = getEnvVarDecryptedValue(id);
  return NextResponse.json({ value });
});
