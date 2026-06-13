import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { deleteJobScript, getJobScriptById, updateJobScript } from "@/lib/db/queries";

export const PUT = withResourceAuth("job", "id", { role: "editor" })(
  async (req, _auth, { params }) => {
    const { id, scriptId } = await params;
    const existing = getJobScriptById(scriptId);
    // The script must exist and belong to the authorized parent job.
    if (!existing || existing.job_id !== id) {
      return NextResponse.json({ error: "Script not found" }, { status: 404 });
    }

    const body = await req.json();
    try {
      const updated = updateJobScript(scriptId, {
        filename: body.filename,
        content: body.content,
        executable: body.executable,
      });
      return NextResponse.json(updated);
    } catch (error) {
      // Filename validation throws a plain Error (house convention → 400).
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id, scriptId } = await params;
    const existing = getJobScriptById(scriptId);
    // The script must exist and belong to the authorized parent job.
    if (!existing || existing.job_id !== id) {
      return NextResponse.json({ error: "Script not found" }, { status: 404 });
    }
    deleteJobScript(scriptId);
    return NextResponse.json({ ok: true });
  },
);
