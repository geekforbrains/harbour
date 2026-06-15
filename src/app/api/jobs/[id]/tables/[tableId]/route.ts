import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { unlinkTableFromJob } from "@/lib/db/queries";

export const DELETE = withResourceAuth("job", "id", { role: "editor" })(
  async (_req, _auth, { params }) => {
    const { id, tableId } = await params;
    unlinkTableFromJob(id, tableId);
    return NextResponse.json({ ok: true });
  },
);
