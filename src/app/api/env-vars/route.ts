import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { orgIdForProject } from "@/lib/db/access";
import { createEnvVar, listEnvVars } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withOrgAuth(
  async (req, auth) => {
    const projectId = req.nextUrl.searchParams.get("projectId") || null;
    return NextResponse.json(listEnvVars(auth.orgId, projectId));
  },
  { role: "viewer" },
);

export const POST = withOrgAuth(
  async (req, auth) => {
    const body = await readJson(req);
    const name = requireNonEmptyString(body.name, "name");
    // Value is required and non-blank, but stored as-is (it may legitimately
    // contain leading/trailing whitespace), so validate without trimming it.
    if (typeof body.value !== "string" || body.value.trim() === "") {
      return NextResponse.json({ error: "name and value are required" }, { status: 400 });
    }

    const projectId =
      optionalString(body.projectId, "projectId") ??
      req.nextUrl.searchParams.get("projectId") ??
      null;
    // A client-supplied project must belong to the caller's org.
    if (projectId && orgIdForProject(projectId) !== auth.orgId) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }
    try {
      const envVar = createEnvVar(auth.orgId, projectId, name, body.value);
      return NextResponse.json(envVar, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
  { role: "editor" },
);
