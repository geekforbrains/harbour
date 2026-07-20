import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { deleteEnvVar, getEnvVarById, updateEnvVar } from "@/lib/db/queries";
import { optionalString, readJson } from "@/lib/http";

export const GET = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const envVar = getEnvVarById(id);
  if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  return NextResponse.json(envVar);
});

export const PUT = withAuthenticatedUser(async (req, _auth, { params }) => {
  const { id } = await params;
  const existing = getEnvVarById(id);
  if (!existing) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

  const body = await readJson(req);
  // value may legitimately contain whitespace, so it is not trimmed.
  const data = {
    name: optionalString(body.name, "name"),
    value: optionalString(body.value, "value"),
  };
  try {
    const updated = updateEnvVar(id, data);
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});

export const DELETE = withAuthenticatedUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  if (!getEnvVarById(id)) return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  deleteEnvVar(id);
  return NextResponse.json({ ok: true });
});
