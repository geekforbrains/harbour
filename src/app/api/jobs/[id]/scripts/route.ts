import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { createJobScript, getJobById, listJobScripts } from "@/lib/db/queries";

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

    const body = await req.json();
    if (typeof body.filename !== "string" || body.filename.length === 0) {
      return NextResponse.json({ error: "filename is required" }, { status: 400 });
    }

    try {
      const script = createJobScript({
        jobId: id,
        filename: body.filename,
        content: body.content,
        executable: body.executable,
      });
      return NextResponse.json(script, { status: 201 });
    } catch (error) {
      // Filename validation throws a plain Error (house convention → 400).
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
