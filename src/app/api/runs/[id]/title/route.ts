import { NextResponse } from "next/server";
import { withAuth, requireAgentOwnership } from "@/lib/auth";
import { getRunById, setRunTitle } from "@/lib/db/queries";
import { normalizeTitle, MAX_TITLE_LENGTH } from "@/lib/run-title";

export const PUT = withAuth(async (req, auth, { params }) => {
  const { id } = await params;
  const run = getRunById(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const ownerError = requireAgentOwnership(auth, run.agent_id);
  if (ownerError) return ownerError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = normalizeTitle((body as { title?: unknown })?.title);
  if (!title) {
    return NextResponse.json(
      { error: `title must be a non-empty string (max ${MAX_TITLE_LENGTH} chars)` },
      { status: 400 }
    );
  }

  return NextResponse.json(setRunTitle(id, title));
});
