import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { createJobScript, getJobById, listJobScripts } from "@/lib/db/queries";
import { optionalBoolean, optionalString, readJson, requireNonEmptyString } from "@/lib/http";

export const GET = withResourceAuth("job", "id", { role: "viewer" })(
  async (_req, _auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(listJobScripts(id));
  },
);

export const POST = withResourceAuth("job", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const job = getJobById(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const body = await readJson(req);
    const filename = requireNonEmptyString(body.filename, "filename");
    const content = optionalString(body.content, "content");
    const executable = optionalBoolean(body.executable, "executable");

    try {
      const script = createJobScript({
        jobId: id,
        filename,
        content,
        executable,
      });
      return NextResponse.json(script, { status: 201 });
    } catch (error) {
      // Filename validation throws a plain Error (house convention → 400).
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
