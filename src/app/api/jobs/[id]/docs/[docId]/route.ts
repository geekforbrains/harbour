import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { unlinkDocFromJob } from "@/lib/db/queries";

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (req, auth, { params }) => {
    const { id, docId } = await params;
    unlinkDocFromJob(id, docId);
    return NextResponse.json({ ok: true });
  }
);
