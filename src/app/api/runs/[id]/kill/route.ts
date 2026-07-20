import { NextResponse } from "next/server";
import { withAuthenticatedUser, withRunExecutorOrUser } from "@/lib/auth";
import { addRunActivity, getRunById, isKillRequested, requestKillRun } from "@/lib/db/queries";

/**
 * Lightweight kill-check endpoint for the runner's fallback poll. Returns just
 * the kill flag so the executor can poll cheaply without pulling the whole run.
 */
export const GET = withRunExecutorOrUser(async (_req, _auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json({ kill_requested: isKillRequested(id), status: run.status });
});

export const POST = withAuthenticatedUser(async (_req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  if (run.status !== "running") {
    return NextResponse.json(
      {
        error: `Cannot kill a run in status '${run.status}' — only 'running' runs can be killed.`,
      },
      { status: 409 },
    );
  }

  const ok = requestKillRun(id);
  if (!ok) {
    return NextResponse.json({ error: "Failed to request kill" }, { status: 500 });
  }

  addRunActivity(id, "system", null, "System", `Kill requested by **${auth.displayName}**`);

  return NextResponse.json({ ok: true, kill_requested: true });
});
