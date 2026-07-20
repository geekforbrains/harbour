import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createEnvVar, listEnvVars } from "@/lib/db/queries";
import { readJson, requireNonEmptyString, resolveProjectId } from "@/lib/http";

export const GET = withAuthenticatedUser(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  return NextResponse.json(listEnvVars(projectId));
});

export const POST = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  // Value is required and non-blank, but stored as-is (it may legitimately
  // contain leading/trailing whitespace), so validate without trimming it.
  if (typeof body.value !== "string" || body.value.trim() === "") {
    return NextResponse.json({ error: "name and value are required" }, { status: 400 });
  }

  const projectId = resolveProjectId(req, body);

  try {
    const envVar = createEnvVar(projectId, name, body.value);
    return NextResponse.json(envVar, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
