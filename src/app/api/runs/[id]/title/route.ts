import { NextResponse } from "next/server";
import { withRunExecutorOrUser } from "@/lib/auth";
import { getRunById, setRunTitle } from "@/lib/db/queries";
import { readJson } from "@/lib/http";
import { MAX_TITLE_LENGTH, normalizeTitle } from "@/lib/run-title";

export const PUT = withRunExecutorOrUser(
  async (req, _auth, { params }) => {
    const { id } = await params;
    const run = getRunById(id);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const body = await readJson(req);

    const title = normalizeTitle(body.title);
    if (!title) {
      return NextResponse.json(
        { error: `title must be a non-empty string (max ${MAX_TITLE_LENGTH} chars)` },
        { status: 400 },
      );
    }

    return NextResponse.json(setRunTitle(id, title));
  },
  { role: "editor" },
);
