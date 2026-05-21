import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getEnvVarById, updateEnvVar, deleteEnvVar } from "@/lib/db/queries";

export const GET = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const envVar = getEnvVarById(id);
  if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });
  return NextResponse.json(envVar);
});

export const PUT = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const existing = getEnvVarById(id);
  if (!existing) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

  const body = await req.json();
  const updated = updateEnvVar(id, body);
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  deleteEnvVar(id);
  return NextResponse.json({ ok: true });
});
