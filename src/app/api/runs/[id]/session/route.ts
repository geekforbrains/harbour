import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { getRunById, updateRunSessionId } from "@/lib/db/queries";
import { optionalString, readJson, requireNonEmptyString } from "@/lib/http";

// The runner saves the CLI session id (+ cwd) so a killed/waiting run resumes in
// place. Executor-only — users never write run sessions.
export const PUT = withRunExecutorOrUser(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  if (auth.type !== "executor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await readJson(req);
  const sessionId = requireNonEmptyString(body.session_id, "session_id");
  const cwd = optionalString(body.cwd, "cwd");

  updateRunSessionId(id, sessionId, cwd || undefined);
  return NextResponse.json({ ok: true });
});
