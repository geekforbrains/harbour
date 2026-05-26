import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getEnvVarById, toggleEnvVarPinned } from "@/lib/db/queries";

export const POST = withResourceAuth("env_var", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    const envVar = getEnvVarById(id);
    if (!envVar) return NextResponse.json({ error: "Env var not found" }, { status: 404 });

    const updated = toggleEnvVarPinned(id);
    return NextResponse.json(updated);
  }
);
