import { NextResponse } from "next/server";
import { withAuth, withUserAuth } from "@/lib/auth";
import { listEnvVars, createEnvVar } from "@/lib/db/queries";

export const GET = withAuth(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  return NextResponse.json(listEnvVars(projectId, workspaceId));
});

export const POST = withUserAuth(async (req) => {
  const body = await req.json();
  if (!body.name?.trim() || !body.value?.trim()) {
    return NextResponse.json({ error: "name and value are required" }, { status: 400 });
  }

  const envVar = createEnvVar(body.name.trim(), body.value);
  return NextResponse.json(envVar, { status: 201 });
});
