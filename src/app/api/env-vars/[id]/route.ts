import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { deleteEnvVar, getEnvVarById, updateEnvVar } from "@/lib/db/queries";

export const GET = withResourceAuth("env_var", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const envVar = getEnvVarById(id);
    if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });
    return NextResponse.json(envVar);
  },
);

export const PUT = withResourceAuth("env_var", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const existing = getEnvVarById(id);
    if (!existing) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

    const body = await req.json();
    try {
      const updated = updateEnvVar(id, body);
      return NextResponse.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);

export const DELETE = withResourceAuth("env_var", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    deleteEnvVar(id);
    return NextResponse.json({ ok: true });
  },
);
