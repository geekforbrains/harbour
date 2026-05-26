import { NextResponse } from "next/server";
import { withResourceAuth } from "@/lib/auth";
import { getDocRevisions } from "@/lib/db/queries";

export const GET = withResourceAuth("doc", "id", { role: "viewer" })(
  async (req, auth, { params }) => {
    const { id } = await params;
    return NextResponse.json(getDocRevisions(id));
  }
);
