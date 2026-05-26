import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getEnvVarById, updateEnvVar, deleteEnvVar } from "@/lib/db/queries";

export const GET = withResourceAuth("env_var", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const envVar = getEnvVarById(id);
    if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });
    return NextResponse.json(envVar);
  }
);

export const PUT = withResourceAuth("env_var", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const existing = getEnvVarById(id);
    if (!existing) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

    const body = await req.json();
    try {
      const updated = updateEnvVar(id, body);
      return NextResponse.json(updated);
    } catch (error: any) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }
);

export const DELETE = withResourceAuth("env_var", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    deleteEnvVar(id);
    return NextResponse.json({ ok: true });
  }
);
