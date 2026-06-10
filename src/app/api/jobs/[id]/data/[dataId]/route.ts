import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { unlinkDatabaseFromJob } from "@/lib/db/queries";

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id, dataId } = await params;
    unlinkDatabaseFromJob(id, dataId);
    return NextResponse.json({ ok: true });
  },
);
