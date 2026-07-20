import { NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/db/queries";
import { readJson, requireNonEmptyString } from "@/lib/http";
import { InvalidNameError, NameCollisionError } from "@/lib/slug";

export const GET = withAuthenticatedUser(async () => {
  return NextResponse.json(listProjects());
});

export const POST = withAuthenticatedUser(async (req) => {
  const body = await readJson(req);
  const name = requireNonEmptyString(body.name, "name");
  try {
    const project = createProject(name);
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof NameCollisionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});
